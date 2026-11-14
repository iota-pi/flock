import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { backOff, VersionConflictError, type BackoffOptions } from '@vault/shared'
import { addSessionRecord, normalizeSessionRecords, renewSessionRecord } from '../../sessions'
import { AuthenticationError } from '../../errors'
import { normalizeLoginDevices, withLoginDevice, withoutLoginDevice } from '../../loginDevices'
import type {
  AuthData,
  BaseData,
  StoredAccount,
  UpdateAccountDataParams,
  VaultAccount,
  VaultSessionRecord,
} from '../vaultDriver'
import { isConditionalCheckFailure } from './dynamoErrors'
import { buildUpdateParams } from './expressions'
import { sendConditional, type DynamoContext } from './commands'

const MAX_SESSION_UPDATE_ATTEMPTS = 3
const SESSION_UPDATE_BACKOFF: BackoffOptions = { baseMs: 10, maxMs: 100, jitterMs: 10 }

export async function createAccount(
  { client, tables }: DynamoContext,
  accountDefaults: Record<string, unknown>,
  {
    account,
    authToken,
    salt,
    iterations,
    saltVersion,
    kdf,
    keyring,
    randomDataKeys,
    keyringVersion,
  }: VaultAccount,
): Promise<boolean> {
  const now = Date.now()
  const created = await sendConditional(client, new PutCommand({
    TableName: tables.accounts,
    Item: {
      ...accountDefaults,
      account,
      authToken,
      created: now,
      lastAccess: now,
      salt,
      ...(iterations !== undefined ? { iterations } : {}),
      saltVersion,
      ...(kdf ? { kdf } : {}),
      ...(keyring ? { keyring } : {}),
      ...(randomDataKeys ? { randomDataKeys } : {}),
      sessions: [],
      keyringVersion: keyringVersion ?? 1,
    },
    ConditionExpression: 'attribute_not_exists(account)',
  }))
  return created !== undefined
}

export async function getAccountRecord(
  { client, tables }: DynamoContext,
  { account }: BaseData,
): Promise<StoredAccount | undefined> {
  const response = await client.send(new GetCommand({
    TableName: tables.accounts,
    Key: { account },
    // Logging in straight after creating an account reads it first
    ConsistentRead: true,
  }))
  return response?.Item as StoredAccount | undefined
}

export async function updateAccountData<TExtra extends object = Record<never, never>>(
  { client, tables }: DynamoContext,
  {
    account,
    expectedKeyringVersion,
    sessions,
    remove,
    ...rest
  }: UpdateAccountDataParams & Partial<TExtra>,
): Promise<void> {
  const update = buildUpdateParams({
    set: {
      ...rest,
      sessions: sessions !== undefined ? normalizeSessionRecords(sessions) : undefined,
    },
    remove,
    condition: typeof expectedKeyringVersion === 'number'
      ? {
        expression: 'attribute_exists(account)'
          + ' AND (keyringVersion = :expectedKeyringVersion OR attribute_not_exists(keyringVersion))',
        values: { ':expectedKeyringVersion': expectedKeyringVersion },
      }
      : { expression: 'attribute_exists(account)' },
  })
  if (!update.UpdateExpression) {
    return
  }

  try {
    await client.send(new UpdateCommand({
      TableName: tables.accounts,
      Key: { account },
      ...update,
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    }))
  } catch (error) {
    if (!isConditionalCheckFailure(error)) {
      throw error
    }
    // The failed check returns the item as it was, if there was one
    if (!(error as { Item?: unknown }).Item) {
      throw new AuthenticationError(`Could not find account ${account}`)
    }
    throw new VersionConflictError('keyringVersion has changed')
  }
}

export async function addStorageUsage(
  { client, tables }: DynamoContext,
  { account, bytes }: BaseData & { bytes: number },
): Promise<void> {
  // ADD needs no read and touches nothing else, so it never conflicts with session writes
  await sendConditional(client, new UpdateCommand({
    TableName: tables.accounts,
    Key: { account },
    UpdateExpression: 'ADD storageBytes :bytes',
    ConditionExpression: 'attribute_exists(account)',
    ExpressionAttributeValues: { ':bytes': bytes },
  }))
}

export async function addSession(
  context: DynamoContext,
  { account, session, expiry, device }: AuthData & { expiry: number, device?: string },
): Promise<void> {
  const added = await updateAccess(context, account, ({ sessions, devices }) => ({
    sessions: addSessionRecord(sessions, session, expiry),
    devices: device === undefined ? undefined : withLoginDevice(devices, device),
  }))
  if (!added) {
    throw new Error(`Could not add a session to account ${account}`)
  }
}

export async function extendSession(context: DynamoContext, { account, session }: AuthData): Promise<void> {
  await updateAccess(context, account, ({ sessions }, now, attempt) => {
    const renewed = renewSessionRecord(sessions, session, now, attempt > 0)
    return renewed && { sessions: renewed }
  })
}

export async function removeLoginDevice(
  context: DynamoContext,
  { account, device }: BaseData & { device: string },
): Promise<void> {
  await updateAccess(context, account, ({ devices }) => {
    const remaining = withoutLoginDevice(devices, device)
    return remaining && { devices: remaining }
  })
}

/** An account's active sessions and login devices */
interface AccessState {
  sessions: VaultSessionRecord[]
  devices: string[]
}

/**
 * Rewrites the account's sessions and login devices on condition that neither has changed since
 * they were read, retrying when a concurrent login, renewal, device removal or password change got
 * there first. `update` gets both and returns those to change, or undefined to leave them as they
 * are. Returns whether it wrote.
 */
async function updateAccess(
  context: DynamoContext,
  account: string,
  update: (state: AccessState, now: number, attempt: number) => Partial<AccessState> | undefined,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_SESSION_UPDATE_ATTEMPTS; attempt += 1) {
    const record = await getAccountRecord(context, { account })
    if (!record) {
      return false
    }

    const rawSessions: unknown = record.sessions
    const rawDevices: unknown = record.loginDevices
    const now = Date.now()
    const next = update({
      sessions: normalizeSessionRecords(rawSessions, now),
      devices: normalizeLoginDevices(rawDevices),
    }, now, attempt)
    if (!next?.sessions && !next?.devices) {
      return false
    }

    const assignments: string[] = []
    const conditions: string[] = []
    const values: Record<string, unknown> = {}
    if (next.sessions) {
      assignments.push('sessions = :sessions', 'lastAccess = :now')
      values[':sessions'] = normalizeSessionRecords(next.sessions, now)
      values[':now'] = now
    }
    if (next.devices) {
      assignments.push('loginDevices = :devices')
      values[':devices'] = next.devices
    }
    if (Array.isArray(rawSessions)) {
      conditions.push('sessions = :expectedSessions')
      values[':expectedSessions'] = rawSessions
    } else {
      conditions.push('attribute_not_exists(sessions)')
    }
    if (rawDevices === undefined) {
      conditions.push('attribute_not_exists(loginDevices)')
    } else {
      conditions.push('loginDevices = :expectedDevices')
      values[':expectedDevices'] = rawDevices
    }
    const written = await sendConditional(context.client, new UpdateCommand({
      TableName: context.tables.accounts,
      Key: { account },
      UpdateExpression: `SET ${assignments.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeValues: values,
    }))
    if (written) {
      return true
    }

    if (attempt < MAX_SESSION_UPDATE_ATTEMPTS - 1) {
      await backOff(attempt, SESSION_UPDATE_BACKOFF)
    }
  }
  return false
}

export async function raiseDataVersion(
  { client, tables }: DynamoContext,
  { account, dataVersion }: BaseData & { dataVersion: number },
): Promise<void> {
  // The condition fails when the account is already at this version or higher
  await sendConditional(client, new UpdateCommand({
    TableName: tables.accounts,
    Key: { account },
    UpdateExpression: 'SET dataVersion = :dataVersion',
    ConditionExpression: 'attribute_exists(account) AND (attribute_not_exists(dataVersion) OR dataVersion < :dataVersion)',
    ExpressionAttributeValues: {
      ':dataVersion': dataVersion,
    },
  }))
}
