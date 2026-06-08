import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  CreateTableCommandInput,
  DynamoDBClient,
  DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb'
import {
  BatchWriteCommand,
  BatchWriteCommandInput,
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
import { chunk } from 'lodash-es'
import {
  almostConstantTimeEqual,
  generateAccountId,
} from '../util'
import BaseDriver, {
  AuthData,
  BaseData,
  StoredSyncMessage,
  VaultAccount,
  VaultAccountWithAuth,
  VaultItem,
  VaultKey,
  VaultSessionRecord,
} from './base'
import type { WebPushSubscription } from '../types'
import { ExpiredSessionError } from '../api/errors'
import { VersionConflictError } from '../../shared/syncErrors'
import type { ItemId } from 'src/shared/schemas/items'

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts'
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems'
export const SYNC_MESSAGES_TABLE_NAME = process.env.SYNC_MESSAGES_TABLE || 'FlockSyncMessages'

const SYNC_MESSAGE_TTL = 7 * 24 * 60 * 60
const PUSH_BATCH_SIZE = 25
const DEFAULT_SYNC_MESSAGE_LIMIT = 200

const DATA_ATTRIBUTES = ['#metadata', '#cipher', '#snapshot']
const DATA_ATTRIBUTE_NAMES = {
  '#metadata': 'metadata',
  '#cipher': 'cipher',
  '#snapshot': 'snapshot',
}

const MAX_ITEM_SIZE = 50_000
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 8
const TOMBSTONE_TTL_SECONDS = 30 * 24 * 60 * 60

type PersistedVaultItem = VaultItem & {
  modifiedAt?: number
}

/**
 * Validates a VaultItem.
 * Supports both legacy cipher and snapshot format
 * - Legacy: must have cipher and iv
 * - Snapshot: must have snapshot payload
 * - Tombstone: needs only metadata.type
 */
function validateItem(item: VaultItem) {
  const isTombstone = item.metadata.deleted === true
  const isLegacy = !!item.cipher
  const isSnapshot = !!item.snapshot

  const hasValidPayload = isTombstone
    ? !!item.metadata.type
    : (isLegacy || isSnapshot) && !!item.metadata.type && (isLegacy ? !!item.metadata.iv : true)

  if (!hasValidPayload) {
    throw new Error(
      `Invalid item format: must be either legacy (cipher+iv) or snapshot. Item: ${JSON.stringify(item)}`,
    )
  }

  const itemLength = JSON.stringify(item).length
  if (itemLength > MAX_ITEM_SIZE) {
    throw new Error(`Item length (${itemLength}) exceeds maximum (${MAX_ITEM_SIZE})`)
  }
}

function getItemPutParams(item: VaultItem): PutCommandInput {
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
      {
        TableName: SYNC_MESSAGES_TABLE_NAME,
        KeySchema: [
          { AttributeName: 'syncId', KeyType: 'HASH' },
          { AttributeName: 'cursor', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'syncId', AttributeType: 'S' },
          { AttributeName: 'cursor', AttributeType: 'N' },
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

  connect(_options?: T, devMode = false): DynamoDriver {
    const options = getConnectionParams(_options)
    const ddb = new DynamoDBClient({
      ...options,
      logger: devMode ? console : undefined,
    })
    this.internalClient = this.getDocumentClient(ddb)
    return this
  }

  async createAccount(
    {
      account,
      authToken,
      metadata,
      salt,
      iterations,
      saltVersion,
    }: VaultAccount,
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
        saltVersion,
        sessions: [],
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
          return {
            ...(response.Item as VaultAccountWithAuth),
            session,
          }
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
          session,
        }
      }
      throw new ExpiredSessionError('Invalid session token')
    }
    throw new Error(`Could not find account ${account}`)
  }

  async getSecurityParams({ account }: BaseData): Promise<{ salt: string, iterations?: number, saltVersion?: number }> {
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
      const saltVersion = dbAccount.saltVersion

      const returnedSalt = typeof salt === 'string' ? salt : account
      return { salt: returnedSalt, iterations, saltVersion }
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
      sessions,
      reminderTimezone,
      lastPrayerCompletedAt,
      lastSnapshotCursor,
      lastSnapshotAt,
      lastSnapshotRequestedAt,
      keyring,
      authToken,
      salt,
      iterations,
      saltVersion,
    }: Partial<AuthData> & {
      metadata?: Record<string, unknown>,
      pushSubscriptions?: WebPushSubscription[],
      reminderEnabled?: boolean,
      reminderTime?: string,
      sessions?: VaultSessionRecord[],
      reminderTimezone?: string,
      lastPrayerCompletedAt?: number,
      lastSnapshotCursor?: number,
      lastSnapshotAt?: number,
      lastSnapshotRequestedAt?: number,
      keyring?: string,
      authToken?: string,
      salt?: string,
      iterations?: number,
      saltVersion?: number,
    },
  ): Promise<void> {
    const updateExpressions: string[] = []
    const expressionAttributeValues: Record<string, unknown> = {}
    const expressionAttributeNames: Record<string, string> = {}
    const conditionExpressions: string[] = []

    if (sessions) {
      updateExpressions.push('sessions = :sessions')
      expressionAttributeValues[':sessions'] = normalizeSessionRecords(sessions)
    }

    if (metadata && Object.keys(metadata).length > 0) {
      updateExpressions.push('metadata=:metadata')
      expressionAttributeValues[':metadata'] = metadata
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
    if (typeof lastSnapshotCursor === 'number') {
      updateExpressions.push('lastSnapshotCursor = :lastSnapshotCursor')
      expressionAttributeValues[':lastSnapshotCursor'] = lastSnapshotCursor
    }
    if (typeof lastSnapshotAt === 'number') {
      updateExpressions.push('lastSnapshotAt = :lastSnapshotAt')
      expressionAttributeValues[':lastSnapshotAt'] = lastSnapshotAt
    }
    if (typeof lastSnapshotRequestedAt === 'number') {
      updateExpressions.push('lastSnapshotRequestedAt = :lastSnapshotRequestedAt')
      expressionAttributeValues[':lastSnapshotRequestedAt'] = lastSnapshotRequestedAt
    }
    if (typeof keyring === 'string') {
      updateExpressions.push('keyring = :keyring')
      expressionAttributeValues[':keyring'] = keyring
    }
    if (typeof authToken === 'string') {
      updateExpressions.push('authToken = :authToken')
      expressionAttributeValues[':authToken'] = authToken
    }
    if (typeof salt === 'string') {
      updateExpressions.push('salt = :salt')
      expressionAttributeValues[':salt'] = salt
    }
    if (typeof iterations === 'number') {
      updateExpressions.push('iterations = :iterations')
      expressionAttributeValues[':iterations'] = iterations
    }
    if (typeof saltVersion === 'number') {
      updateExpressions.push('saltVersion = :saltVersion')
      expressionAttributeValues[':saltVersion'] = saltVersion
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

  async extendSession({ account, session }: AuthData): Promise<void> {
    const response = await this.client.send(new GetCommand({
      TableName: ACCOUNT_TABLE_NAME,
      Key: { account },
      ConsistentRead: true,
    }))

    if (response?.Item) {
      const now = Date.now()
      const activeSessions = normalizeSessionRecords(response.Item.sessions, now)
      const sessionRecord = activeSessions.find(active => almostConstantTimeEqual(session, active.token))
      if (sessionRecord) {
        sessionRecord.expiry = now + SESSION_EXPIRY_MS
        await this.client.send(new UpdateCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET sessions = :sessions',
          ExpressionAttributeValues: {
            ':sessions': activeSessions,
          },
        }))
      }
    }
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
    const params = getItemPutParams(item)

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
        ProjectionExpression: [...DATA_ATTRIBUTES, '#ttl'].join(', '),
        ExpressionAttributeNames: {
          ...DATA_ATTRIBUTE_NAMES,
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
          ...DATA_ATTRIBUTE_NAMES,
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

  async fetchMetadataAll(
    { account }: { account: string },
  ): Promise<Array<{ item: string; metadata: import('./base').VaultMetaData }>> {
    const items: Array<{ item: string; metadata: import('./base').VaultMetaData }> = []
    let lastEvaluatedKey: QueryCommandOutput['LastEvaluatedKey'] | undefined = undefined

    while (true) {
      const queryInput: QueryCommandInput = {
        TableName: ITEM_TABLE_NAME,
        KeyConditionExpression: 'account = :accountid',
        ExpressionAttributeNames: {
          '#itemKey': 'item',
          '#metadata': 'metadata',
        },
        ExpressionAttributeValues: {
          ':accountid': account,
        },
        ProjectionExpression: '#itemKey, #metadata',
        ExclusiveStartKey: lastEvaluatedKey,
      }

      const response = await this.client.send(new QueryCommand(queryInput))

      if (response?.Items) {
        items.push(...response.Items as Array<{ item: string; metadata: import('./base').VaultMetaData }>)
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

  private async executeBatchWriteWithRetry(
    requestItems: BatchWriteCommandInput['RequestItems'],
    maxRetries = 5,
  ): Promise<void> {
    let currentRequestItems = requestItems
    let attempt = 0
    let delayMs = 100

    while (true) {
      const response = await this.client.send(new BatchWriteCommand({
        RequestItems: currentRequestItems,
      }))

      const unprocessed = response.UnprocessedItems
      if (!unprocessed || Object.keys(unprocessed).length === 0) {
        break
      }

      attempt += 1
      if (attempt > maxRetries) {
        throw new Error(`Failed to execute BatchWriteCommand after ${maxRetries} attempts due to DynamoDB unprocessed items.`)
      }

      const jitter = Math.random() * 50
      await new Promise(resolve => setTimeout(resolve, delayMs + jitter))
      delayMs *= 2

      currentRequestItems = unprocessed
    }
  }

  async appendSyncMessage(input: {
    account: string
    itemId: ItemId
    entry: StoredSyncMessage
  }): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: SYNC_MESSAGES_TABLE_NAME,
      Item: {
        syncId: `${input.account}#${input.itemId}`,
        cursor: input.entry.cursor,
        encryptedMessage: input.entry.encryptedMessage,
        createdAt: input.entry.createdAt,
        expiresAt: Math.floor(Date.now() / 1000) + SYNC_MESSAGE_TTL,
      },
    }))
  }

  async pushSyncMessagesBatch(input: {
    account: string
    messages: Array<{
      itemId: ItemId
      entry: StoredSyncMessage
      lastModified: number
    }>
  }): Promise<void> {
    const batches = chunk(input.messages, PUSH_BATCH_SIZE)

    await Promise.all(
      batches.map(async batch => {
        const requestItems: BatchWriteCommandInput['RequestItems'] = {
          [SYNC_MESSAGES_TABLE_NAME]: batch.map(message => ({
            PutRequest: {
              Item: {
                syncId: `${input.account}#${message.itemId}`,
                cursor: message.entry.cursor,
                encryptedMessage: message.entry.encryptedMessage,
                createdAt: message.entry.createdAt,
                expiresAt: Math.floor(Date.now() / 1000) + SYNC_MESSAGE_TTL,
              },
            },
          })),
        }

        await this.executeBatchWriteWithRetry(requestItems)
      }),
    )
  }

  async getSyncMessages(input: {
    account: string
    itemId: ItemId
    fromCursor?: number
    limit?: number
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }> {
    const fromCursor = typeof input.fromCursor === 'number' ? input.fromCursor : undefined
    const hasCursor = typeof fromCursor === 'number'
    const response = await this.client.send(new QueryCommand({
      TableName: SYNC_MESSAGES_TABLE_NAME,
      KeyConditionExpression: hasCursor
        ? 'syncId = :syncId AND #c > :fromCursor'
        : 'syncId = :syncId',
      ExpressionAttributeNames: hasCursor
        ? { '#c': 'cursor' }
        : undefined,
      ExpressionAttributeValues: {
        ':syncId': `${input.account}#${input.itemId}`,
        ...(hasCursor ? { ':fromCursor': fromCursor } : undefined),
      },
      Limit: input.limit ?? DEFAULT_SYNC_MESSAGE_LIMIT,
    }))

    return {
      messages: (response.Items as StoredSyncMessage[]) || [],
      hasMore: !!response.LastEvaluatedKey,
    }
  }

  async pruneSyncMessagesUpToCursor(input: { account: string; itemId: ItemId; cursor: number }): Promise<number> {
    const syncId = `${input.account}#${input.itemId}`
    let deleted = 0
    let lastEvaluatedKey: Record<string, unknown> | undefined

    do {
      const response = await this.client.send(new QueryCommand({
        TableName: SYNC_MESSAGES_TABLE_NAME,
        KeyConditionExpression: 'syncId = :syncId AND #c <= :cursor',
        ExpressionAttributeNames: { '#c': 'cursor' },
        ExpressionAttributeValues: {
          ':syncId': syncId,
          ':cursor': input.cursor,
        },
        ProjectionExpression: '#c',
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: PUSH_BATCH_SIZE,
      }))

      const items = (response.Items as Array<{ cursor: number }>) || []
      if (items.length > 0) {
        const requestItems: BatchWriteCommandInput['RequestItems'] = {
          [SYNC_MESSAGES_TABLE_NAME]: items.map(item => ({
            DeleteRequest: {
              Key: {
                syncId,
                cursor: item.cursor,
              },
            },
          })),
        }

        await this.executeBatchWriteWithRetry(requestItems)
        deleted += items.length
      }

      lastEvaluatedKey = response.LastEvaluatedKey
    } while (lastEvaluatedKey)

    return deleted
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
