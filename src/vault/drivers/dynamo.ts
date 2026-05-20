import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  CreateTableCommandInput,
  DynamoDBClient,
  DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  PutCommandInput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommand,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { randomBytes } from 'crypto'
import {
  almostConstantTimeEqual,
  generateAccountId,
} from '../util'
import BaseDriver, {
  AuthData,
  BaseData,
  VaultAccountWithAuth,
  VaultItem,
  VaultKey,
  VaultSessionRecord,
} from './base'
import type { WebPushSubscription } from '../types'
import { ExpiredSessionError } from '../api/errors'
import { VersionConflictError } from '../../shared/syncErrors'

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts'
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems'
const DATA_ATTRIBUTES = ['metadata', 'cipher', 'branches']

const MAX_ITEM_SIZE = 50000
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 8
const TOMBSTONE_TTL_SECONDS = 30 * 24 * 60 * 60

type WritableVaultItem = VaultItem & {
  _expectedParentVersionId?: string
}

type PersistedVaultItem = VaultItem & {
  modifiedAt?: number
}

/**
 * Validates a VaultItem supports both legacy cipher and new branches format
 * - Legacy: must have cipher and iv
 * - Branching: must have branches array
 * - Tombstone: needs only metadata.type
 */
function validateItem(item: VaultItem) {
  const isTombstone = item.metadata.deleted === true
  const isLegacy = !!item.cipher
  const isBranching = !!item.branches && item.branches.length > 0

  const hasValidPayload = isTombstone
    ? !!item.metadata.type
    : (isLegacy || isBranching) && !!item.metadata.type && (isLegacy ? !!item.metadata.iv : true)

  if (!hasValidPayload) {
    throw new Error(
      `Invalid item format: must be either legacy (cipher+iv) or branching (branches array). Item: ${JSON.stringify(item)}`,
    )
  }
  const itemLength = JSON.stringify(item).length
  if (itemLength > MAX_ITEM_SIZE) {
    throw new Error(`Item length (${itemLength}) exceeds maximum (${MAX_ITEM_SIZE})`)
  }
}

function getItemPutParams(item: VaultItem, expectedParentVersionId?: string): PutCommandInput {
  validateItem(item)

  const modifiedAt = typeof item.metadata?.modified === 'number' ? item.metadata.modified : undefined
  const shouldSetTtl = item.metadata?.deleted === true && typeof item.ttl !== 'number'
  const ttl = shouldSetTtl
    ? Math.floor(Date.now() / 1000) + TOMBSTONE_TTL_SECONDS
    : item.ttl

  const persistedItem: PersistedVaultItem = {
    ...item,
    ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  }

  const params: PutCommandInput = {
    TableName: ITEM_TABLE_NAME,
    Item: persistedItem,
  }

  if (persistedItem.branches && persistedItem.branches.length > 0) {
    if (expectedParentVersionId) {
      params.ExpressionAttributeNames = {
        '#branches': 'branches',
        '#versionId': 'versionId',
      }
      params.ConditionExpression = '#branches[0].#versionId = :expectedParentVersionId'
      params.ExpressionAttributeValues = {
        ':expectedParentVersionId': expectedParentVersionId,
      }
    } else {
      params.ExpressionAttributeNames = {
        '#item': 'item',
        '#branches': 'branches',
      }
      // Genesis writes are allowed for brand-new records and lazy upgrades
      // from legacy rows that do not yet have branches.
      params.ConditionExpression = 'attribute_not_exists(#item) OR attribute_not_exists(#branches)'
    }
  }

  return params
}

function isConditionalCheckFailure(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.name === 'ConditionalCheckFailedException'
    || error.message.includes('ConditionalCheckFailed')
    || error.message.includes('conditional request failed')
  )
}

function normalizeSessionRecords(value: unknown, now = Date.now()): VaultSessionRecord[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Map<string, VaultSessionRecord>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const token = (entry as { token?: unknown }).token
    const expiry = (entry as { expiry?: unknown }).expiry
    if (typeof token !== 'string' || token.length === 0) {
      continue
    }

    if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= now) {
      continue
    }

    deduped.set(token, { token, expiry })
  }

  return Array.from(deduped.values())
    .sort((left, right) => left.expiry - right.expiry)
    .slice(-MAX_ACTIVE_SESSIONS)
}

export default class DynamoDriver<T extends DynamoDBClientConfig = DynamoDBClientConfig> extends BaseDriver<T> {
  private internalClient: DynamoDBDocumentClient | undefined

  private getDocumentClient(ddb: DynamoDBClient) {
    return DynamoDBDocumentClient.from(ddb, {
      marshallOptions: {
        // Some item fields are optional and can be undefined (for example metadata.deleted).
        // Strip them before marshalling to avoid runtime 500s from util-dynamodb.
        removeUndefinedValues: true,
      },
    })
  }

  get client() {
    if (!this.internalClient) {
      throw new Error('Cannot use client before initialisation')
    }
    return this.internalClient
  }

  async init(_: T | undefined = undefined) {
    const isResourceInUseError = (err: unknown) => {
      if (!err || typeof err !== 'object') {
        return false
      }

      const typed = err as {
        name?: unknown
        code?: unknown
        __type?: unknown
      }

      return typed.name === 'ResourceInUseException'
        || typed.code === 'ResourceInUseException'
        || (typeof typed.__type === 'string' && typed.__type.includes('ResourceInUseException'))
    }

    const tablesToEnsure: Pick<CreateTableCommandInput, 'TableName' | 'KeySchema' | 'AttributeDefinitions'>[] = [
      {
        TableName: ITEM_TABLE_NAME,
        KeySchema: [
          { AttributeName: 'account', KeyType: 'HASH' },
          { AttributeName: 'item', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'account', AttributeType: 'S' },
          { AttributeName: 'item', AttributeType: 'S' },
        ],
      },
      {
        TableName: ACCOUNT_TABLE_NAME,
        KeySchema: [
          { AttributeName: 'account', KeyType: 'HASH' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'account', AttributeType: 'S' },
        ],
      },
    ]

    for (const table of tablesToEnsure) {
      try {
        console.info(`Create table: ${table.TableName}`)
        await this.client.send(new CreateTableCommand(
          {
            TableName: table.TableName,
            KeySchema: table.KeySchema,
            AttributeDefinitions: table.AttributeDefinitions,
            BillingMode: 'PAY_PER_REQUEST',
          },
        ))
        console.info(`Table created: ${table.TableName}`)
      } catch (err: unknown) {
        if (!isResourceInUseError(err)) {
          throw err
        }
        console.info('Already exists, skipping.')
      }
    }

    return this
  }

  connect(_options?: T): DynamoDriver {
    const options = getConnectionParams(_options)
    const ddb = new DynamoDBClient(options)
    this.internalClient = this.getDocumentClient(ddb)
    return this
  }

  async createAccount(
    {
      account,
      authToken,
      metadata,
      salt,
      session,
      iterations,
    }: VaultAccountWithAuth & { authToken: string },
  ): Promise<boolean> {
    let success = true
    await this.client.send(new PutCommand({
      TableName: ACCOUNT_TABLE_NAME,
      Item: {
        account,
        authToken,
        created: Date.now(),
        lastAccess: Date.now(),
        metadata,
        pushSubscriptions: [],
        reminderEnabled: false,
        reminderTime: '08:00',
        reminderTimezone: 'UTC',
        salt,
        iterations,
        session,
        // This session is just a placeholder, so set it as expired
        sessionExpiry: 0,
      },
      ConditionExpression: 'attribute_not_exists(account)',
    })).catch(error => {
      success = false
      if (!isConditionalCheckFailure(error)) {
        throw error
      }
    })
    return success
  }

  async getAccount(
    { account, isLogin, session }: AuthData & { isLogin?: boolean },
  ): Promise<VaultAccountWithAuth> {
    if (!session) {
      throw new Error('Session is required to get account')
    }
    const response = await this.client.send(new GetCommand(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
        ConsistentRead: true,
      },
    ))
    if (response?.Item) {
      if (isLogin) {
        // For logins, check authToken instead
        if (almostConstantTimeEqual(session, response.Item.authToken as string)) {
          return response.Item as VaultAccountWithAuth
        }
        // Give same error as if account not found to avoid leaking account ids
        throw new Error(`Could not find account ${account}`)
      }

      const now = Date.now()
      const activeSessions = normalizeSessionRecords(response.Item.sessions, now)
      if (activeSessions.some(active => almostConstantTimeEqual(session, active.token))) {
        return {
          ...(response.Item as VaultAccountWithAuth),
          sessions: activeSessions,
        }
      }

      const sessionExpiry = response.Item.sessionExpiry as number | undefined
      if (sessionExpiry && sessionExpiry < now) {
        throw new ExpiredSessionError('Invalid session token')
      }
      if (almostConstantTimeEqual(session, response.Item.session as string)) {
        return response.Item as VaultAccountWithAuth
      }
      throw new ExpiredSessionError('Invalid session token')
    }
    throw new Error(`Could not find account ${account}`)
  }

  async getSecurityParams({ account }: BaseData): Promise<{ salt: string, iterations?: number }> {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
      },
    ))
    if (response?.Item) {
      const dbAccount = response.Item as VaultAccountWithAuth
      const salt = dbAccount.salt
      const iterations = dbAccount.iterations

      const returnedSalt = typeof salt === 'string' ? salt : account
      return { salt: returnedSalt, iterations }
    }
    throw new Error(`Could not find account ${account}`)
  }

  async getNewAccountId(maxAttempts = 10): Promise<string> {
    let attempts = 0

    while (attempts < maxAttempts) {
      attempts += 1
      const account = generateAccountId()

      try {
        const response = await this.client.send(new GetCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
        }))
        if (!response?.Item) {
          return account
        }
      } catch (error) {
        if (attempts === maxAttempts) {
          throw error
        }
      }
    }

    throw new Error('Could not generate new account ID')
  }

  async updateAccountData(
    {
      account,
      metadata,
      pushSubscriptions,
      reminderEnabled,
      reminderTime,
      session,
      sessions,
      reminderTimezone,
      lastPrayerCompletedAt,
      expectedMetadataParentVersionId,
    }: Partial<AuthData> & {
      metadata?: Record<string, unknown>,
      pushSubscriptions?: WebPushSubscription[],
      reminderEnabled?: boolean,
      reminderTime?: string,
      session?: string,
      sessions?: VaultSessionRecord[],
      reminderTimezone?: string,
      lastPrayerCompletedAt?: number,
      expectedMetadataParentVersionId?: string,
    },
  ): Promise<void> {
    const updateExpressions: string[] = []
    const expressionAttributeValues: Record<string, unknown> = {}
    const expressionAttributeNames: Record<string, string> = {}
    const conditionExpressions: string[] = []

    if (session) {
      updateExpressions.push('#session=:session', 'sessionExpiry=:expiry')
      expressionAttributeValues[':session'] = session
      expressionAttributeValues[':expiry'] = Date.now() + SESSION_EXPIRY_MS
      expressionAttributeNames['#session'] = 'session'
    }

    if (sessions) {
      updateExpressions.push('sessions = :sessions')
      expressionAttributeValues[':sessions'] = normalizeSessionRecords(sessions)
    }

    if (metadata && Object.keys(metadata).length > 0) {
      updateExpressions.push('metadata=:metadata')
      expressionAttributeValues[':metadata'] = metadata

      if (typeof expectedMetadataParentVersionId === 'string' && expectedMetadataParentVersionId.length > 0) {
        conditionExpressions.push('metadata.branches[0].versionId = :expectedParentVersionId')
        expressionAttributeValues[':expectedParentVersionId'] = expectedMetadataParentVersionId
      } else {
        const incomingBranches = (metadata as { branches?: unknown }).branches
        if (Array.isArray(incomingBranches) && incomingBranches.length > 0) {
          conditionExpressions.push('attribute_not_exists(metadata.branches)')
        }
      }
    }

    if (pushSubscriptions) {
      updateExpressions.push('pushSubscriptions = :pushSubscriptions')
      expressionAttributeValues[':pushSubscriptions'] = pushSubscriptions
    }
    if (typeof reminderEnabled === 'boolean') {
      updateExpressions.push('reminderEnabled = :reminderEnabled')
      expressionAttributeValues[':reminderEnabled'] = reminderEnabled
    }
    if (typeof reminderTime === 'string') {
      updateExpressions.push('reminderTime = :reminderTime')
      expressionAttributeValues[':reminderTime'] = reminderTime
    }
    if (typeof reminderTimezone === 'string') {
      updateExpressions.push('reminderTimezone = :reminderTimezone')
      expressionAttributeValues[':reminderTimezone'] = reminderTimezone
    }
    if (typeof lastPrayerCompletedAt === 'number') {
      updateExpressions.push('lastPrayerCompletedAt = :lastPrayerCompletedAt')
      expressionAttributeValues[':lastPrayerCompletedAt'] = lastPrayerCompletedAt
    }

    if (updateExpressions.length === 0) {
      return
    }

    const params: UpdateCommandInput = {
      TableName: ACCOUNT_TABLE_NAME,
      Key: { account },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
    }

    if (Object.keys(expressionAttributeNames).length > 0) {
      params.ExpressionAttributeNames = expressionAttributeNames
    }

    if (conditionExpressions.length > 0) {
      params.ConditionExpression = conditionExpressions.join(' AND ')
    }

    await this.client.send(new UpdateCommand(params))
  }

  async extendSession({ account }: BaseData): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: ACCOUNT_TABLE_NAME,
      Key: { account },
      UpdateExpression: 'SET sessionExpiry = :expiry',
      ExpressionAttributeValues: {
        ':expiry': Date.now() + SESSION_EXPIRY_MS,
      },
    }))
  }

  async startNewSession({ account }: BaseData): Promise<string> {
    const sessionId = randomBytes(16).toString('base64')
    await this.client.send(new UpdateCommand(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
        UpdateExpression: 'SET #session=:session',
        ExpressionAttributeValues: {
          ':session': sessionId,
        },
        ExpressionAttributeNames: {
          '#session': 'session',
        },
      },
    ))
    return sessionId
  }

  async checkSession(
    { account, isLogin, session }: AuthData & { isLogin?: boolean },
  ): Promise<{ success: boolean, reason?: string }> {
    try {
      const result = await this.getAccount({ account, isLogin, session })
      if (result) {
        await this.client.send(new UpdateCommand(
          {
            TableName: ACCOUNT_TABLE_NAME,
            Key: { account },
            UpdateExpression: 'SET lastAccess=:now',
            ExpressionAttributeValues: {
              ':now': Date.now(),
            },
          },
        ))
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      if (error instanceof ExpiredSessionError) {
        return { success: false, reason: 'expired' }
      }
      return { success: false }
    }
  }

  async set(item: VaultItem) {
    const writable = item as WritableVaultItem
    const params = getItemPutParams(item, writable._expectedParentVersionId)

    try {
      await this.client.send(new PutCommand(params))
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        throw new VersionConflictError('Version conflict: The item has been modified by another client.')
      }
      throw err
    }
  }

  async get({ account, item }: VaultKey) {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ITEM_TABLE_NAME,
        Key: { account, item },
        ProjectionExpression: [...DATA_ATTRIBUTES, '#ttl'].join(','),
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
      },
    ))
    if (response?.Item) {
      return response.Item as VaultItem
    } else {
      throw new Error(`Could not find item (${item}) for this account (${account})`)
    }
  }

  // fetchAll is used only for legacy migration
  async fetchAll(
    { account }: { account: string },
  ): Promise<VaultItem[]> {
    const items: VaultItem[] = []
    let lastEvaluatedKey: QueryCommandOutput['LastEvaluatedKey'] | undefined = undefined

    const projectionExpression = ['#itemKey', ...DATA_ATTRIBUTES].join(',')

    while (true) {
      const queryInput: QueryCommandInput = {
        TableName: ITEM_TABLE_NAME,
        KeyConditionExpression: 'account = :accountid',
        ExpressionAttributeNames: {
          '#itemKey': 'item',
        },
        ExpressionAttributeValues: {
          ':accountid': account,
        },
        ProjectionExpression: projectionExpression,
        ExclusiveStartKey: lastEvaluatedKey,
      }

      const response = await this.client.send(new QueryCommand(queryInput))

      if (response?.Items) {
        items.push(...response?.Items as VaultItem[])
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
      if (!lastEvaluatedKey) {
        break
      }
    }

    return items
  }

  async delete({ account, item }: VaultKey) {
    await this.client.send(new DeleteCommand({
      TableName: ITEM_TABLE_NAME,
      Key: { account, item },
    }))
  }
}

export function getConnectionParams(options?: DynamoDBClientConfig): DynamoDBClientConfig {
  const customEndpoint = !!process.env.DYNAMODB_ENDPOINT
  const endpointArgs: DynamoDBClientConfig = customEndpoint ? {
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: 'local',
  } : {}
  return {
    apiVersion: '2012-08-10',
    region: 'ap-southeast-2',
    ...endpointArgs,
    ...options,
  }
}
