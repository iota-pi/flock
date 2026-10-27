import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { backOff, VersionConflictError, type BackoffOptions } from '@vault/shared'
import { addSessionRecord, normalizeSessionRecords, renewSessionRecord } from '../../sessions'
import { AuthenticationError } from '../../errors'
import { FAILED_LOGIN_WINDOW_MS } from '../../loginThrottle'
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
      keyringVersion: 1,
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

export async function recordFailedLogin({ client, tables }: DynamoContext, { account }: BaseData): Promise<void> {
  const now = Date.now()
  const values = { ':one': 1, ':windowStart': now - FAILED_LOGIN_WINDOW_MS }
  // Count within the current window. The conditions keep both writes from creating an item for an
  // account that doesn't exist.
  const counted = await sendConditional(client, new UpdateCommand({
    TableName: tables.accounts,
    Key: { account },
    UpdateExpression: 'ADD failedLogins :one',
    ConditionExpression: 'attribute_exists(account) AND failedLoginsSince > :windowStart',
    ExpressionAttributeValues: values,
  }))
  if (counted) {
    return
  }
  // Or start a new window. If a concurrent failure started it first, this one goes uncounted.
  await sendConditional(client, new UpdateCommand({
    TableName: tables.accounts,
    Key: { account },
    UpdateExpression: 'SET failedLogins = :one, failedLoginsSince = :now',
    ConditionExpression:
      'attribute_exists(account) AND (attribute_not_exists(failedLoginsSince) OR failedLoginsSince <= :windowStart)',
    ExpressionAttributeValues: { ...values, ':now': now },
  }))
}

export async function updateAccountData<TExtra extends object = Record<never, never>>(
  { client, tables }: DynamoContext,
  {
    account,
    expectedKeyringVersion,
    sessions,
    ...rest
  }: UpdateAccountDataParams & Partial<TExtra>,
): Promise<void> {
  const update = buildUpdateParams({
    set: {
      ...rest,
      sessions: sessions !== undefined ? normalizeSessionRecords(sessions) : undefined,
    },
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

export async function addSession(
  context: DynamoContext,
  { account, session, expiry }: AuthData & { expiry: number },
): Promise<void> {
  const added = await updateSessions(context, account, activeSessions => addSessionRecord(activeSessions, session, expiry))
  if (!added) {
    throw new Error(`Could not add a session to account ${account}`)
  }
}

export async function extendSession(context: DynamoContext, { account, session }: AuthData): Promise<void> {
  await updateSessions(context, account, (activeSessions, now, attempt) => (
    renewSessionRecord(activeSessions, session, now, attempt > 0)
  ))
}

/**
 * Rewrites the account's sessions on condition that they haven't changed since they were read,
 * retrying when a concurrent login, renewal or password change got there first. `update` gets the
 * active sessions and returns the new list, or undefined to leave them as they are. Returns whether
 * it wrote.
 */
async function updateSessions(
  context: DynamoContext,
  account: string,
  update: (activeSessions: VaultSessionRecord[], now: number, attempt: number) => VaultSessionRecord[] | undefined,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_SESSION_UPDATE_ATTEMPTS; attempt += 1) {
    const record = await getAccountRecord(context, { account })
    if (!record) {
      return false
    }

    const rawSessions: unknown = record.sessions
    const now = Date.now()
    const nextSessions = update(normalizeSessionRecords(rawSessions, now), now, attempt)
    if (!nextSessions) {
      return false
    }

    const values = {
      ':sessions': normalizeSessionRecords(nextSessions, now),
      ':now': now,
    }
    const written = await sendConditional(context.client, new UpdateCommand({
      TableName: context.tables.accounts,
      Key: { account },
      UpdateExpression: 'SET sessions = :sessions, lastAccess = :now',
      ...(Array.isArray(rawSessions)
        ? {
          ConditionExpression: 'sessions = :expectedSessions',
          ExpressionAttributeValues: { ...values, ':expectedSessions': rawSessions },
        }
        : {
          ConditionExpression: 'attribute_not_exists(sessions)',
          ExpressionAttributeValues: values,
        }),
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
