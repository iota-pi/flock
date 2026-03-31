import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DynamoDBClient,
  DynamoDBClientConfig,
  ResourceInUseException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  PutCommandInput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  TransactWriteCommand,
  UpdateCommand,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { randomBytes } from 'crypto'
import {
  almostConstantTimeEqual,
  generateAccountId,
} from '../util'
import BaseDriver, {
  ArchiveAndReplaceInput,
  ArchiveAndSetManyInput,
  AuthData,
  BaseData,
  CachedVaultItem,
  VaultAccountWithAuth,
  VaultItemHistory,
  VaultItem,
  VaultKey,
} from './base'
import type { WebPushSubscription } from '../types'
import { ExpiredSessionError } from '../api/errors'
import { VersionConflictError } from '../../shared/syncErrors'

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts'
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems'
export const ITEM_HISTORY_TABLE = process.env.ITEM_HISTORY_TABLE || 'FlockItemHistory'
export const IDEMPOTENCY_TABLE_NAME = process.env.IDEMPOTENCY_TABLE || 'FlockIdempotency'
const DATA_ATTRIBUTES = ['metadata', 'cipher', 'branches']

export const MAX_ITEM_SIZE = 50000
export const MAX_ITEMS_FETCH = 5000
export const MAX_TRANSACTION_ITEMS = 100
export const MAX_BATCH_GET_ITEMS = 100
export const MAX_TRANSACTION_BYTES = 3_500_000
export const MAX_BATCH_GET_RETRIES = 5
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
export const ITEM_TTL_SECONDS = 30 * 24 * 60 * 60

type WritableVaultItem = VaultItem & {
  _expectedParentVersionId?: string
}

export class TransactionConflictsError extends Error {
  conflictedIds: string[]

  constructor(conflictedIds: string[]) {
    super('Transaction conflicts')
    this.name = 'TransactionConflictsError'
    this.conflictedIds = conflictedIds
  }
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

  const isTombstone = item.metadata.deleted === true
  const persistedItem: VaultItem = isTombstone
    ? {
      ...item,
      ttl: Math.floor(Date.now() / 1000) + ITEM_TTL_SECONDS,
    }
    : {
      ...item,
      ttl: undefined,
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

function estimateTransactWriteBytes(item: VaultItem): number {
  const persistedItem = item.metadata.deleted
    ? {
      ...item,
      ttl: Math.floor(Date.now() / 1000) + ITEM_TTL_SECONDS,
    }
    : item

  return Buffer.byteLength(JSON.stringify({ Put: { Item: persistedItem } }), 'utf8')
}

function chunkItemsForTransactions(items: VaultItem[]): VaultItem[][] {
  const chunks: VaultItem[][] = []
  let currentChunk: VaultItem[] = []
  let currentChunkByteSize = 0

  for (const item of items) {
    const itemBytes = estimateTransactWriteBytes(item)
    const shouldSplitChunk = currentChunk.length > 0 && (
      currentChunk.length === MAX_TRANSACTION_ITEMS
      || currentChunkByteSize + itemBytes >= MAX_TRANSACTION_BYTES
    )

    if (shouldSplitChunk) {
      chunks.push(currentChunk)
      currentChunk = []
      currentChunkByteSize = 0
    }

    currentChunk.push(item)
    currentChunkByteSize += itemBytes
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk)
  }

  return chunks
}

function chunkKeys<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }
  return chunks
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

function isTransactionCanceled(error: unknown): boolean {
  if (error instanceof TransactionCanceledException) {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.name === 'TransactionCanceledException'
    || error.message.includes('TransactionCanceledException')
  )
}

function getTransactionCancellationReasons(error: unknown): Array<{ Code?: string }> {
  if (!error || typeof error !== 'object') {
    return []
  }

  const typed = error as {
    CancellationReasons?: Array<{ Code?: string }>
    cancellationReasons?: Array<{ Code?: string }>
  }

  return typed.CancellationReasons || typed.cancellationReasons || []
}

function isMissingDeltaIndexError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'ValidationException' || error.message.includes('ValidationException')
}

function isHistoryTableMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.name === 'ResourceNotFoundException'
    || error.message.includes('Requested resource not found')
    || error.message.includes('Cannot do operations on a non-existent table')
  )
}

function shouldIgnoreHistoryError(error: unknown): boolean {
  if (isHistoryTableMissing(error)) {
    return true
  }

  // History is additive safety data; non-production environments should
  // not block primary item writes due table drift.
  return process.env.NODE_ENV !== 'production'
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

  async init(_options?: T) {
    const options = getConnectionParams(_options)
    const ddb = new DynamoDBClient(options)
    const client = this.getDocumentClient(ddb)

    try {
      await client.send(new CreateTableCommand(
        {
          TableName: ITEM_TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'account',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'item',
              KeyType: 'RANGE',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
            {
              AttributeName: 'item',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
      }
    }

    try {
      await client.send(new CreateTableCommand(
        {
          TableName: IDEMPOTENCY_TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'idempotencyKey',
              KeyType: 'HASH',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'idempotencyKey',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
      }
    }

    try {
      await client.send(new CreateTableCommand(
        {
          TableName: ACCOUNT_TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'account',
              KeyType: 'HASH',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
      }
    }

    try {
      await client.send(new CreateTableCommand(
        {
          TableName: ITEM_HISTORY_TABLE,
          KeySchema: [
            {
              AttributeName: 'account',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'historyKey',
              KeyType: 'RANGE',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
            {
              AttributeName: 'historyKey',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
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

  async getAccountSalt({ account }: BaseData): Promise<string> {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
      },
    ))
    if (response?.Item) {
      const salt = (response.Item as VaultAccountWithAuth).salt
      if (typeof salt === 'string') {
        return salt
      }
      // Backwards compatibility: account ID used to be used as salt
      // NB: could remove this if we run an upgrade script
      return account
    }
    throw new Error(`Could not find account ${account}`)
  }

  async getNewAccountId(attempts = 10): Promise<string> {
    const account = generateAccountId()

    try {
      const response = await this.client.send(new GetCommand(
        {
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
        },
      ))
      if (!response?.Item) {
        return account
      }
    } catch (error) {
      if (attempts === 0) {
        throw error
      }
    }

    if (attempts > 0) {
      return this.getNewAccountId(attempts - 1)
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
      reminderTimezone,
      lastPrayerCompletedAt,
      expectedMetadataParentVersionId,
    }: Partial<AuthData> & {
      metadata?: Record<string, unknown>,
      pushSubscriptions?: WebPushSubscription[],
      reminderEnabled?: boolean,
      reminderTime?: string,
      session?: string,
      reminderTimezone?: string,
      lastPrayerCompletedAt?: number,
      expectedMetadataParentVersionId?: string,
    },
  ): Promise<void> {
    const promises: Promise<unknown>[] = []

    if (session) {
      promises.push(
        this.client.send(new UpdateCommand(
          {
            TableName: ACCOUNT_TABLE_NAME,
            Key: { account },
            UpdateExpression: 'SET #session=:session, sessionExpiry=:expiry',
            ExpressionAttributeValues: {
              ':session': session,
              ':expiry': Date.now() + SESSION_EXPIRY_MS,
            },
            ExpressionAttributeNames: {
              '#session': 'session',
            },
          },
        ))
      )
    }

    if (metadata && Object.keys(metadata).length > 0) {
      const params: UpdateCommandInput = {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
        UpdateExpression: 'SET metadata=:metadata',
        ExpressionAttributeValues: {
          ':metadata': metadata,
        },
      }

      if (typeof expectedMetadataParentVersionId === 'string' && expectedMetadataParentVersionId.length > 0) {
        params.ConditionExpression = 'metadata.branches[0].versionId = :expectedParentVersionId'
        params.ExpressionAttributeValues![':expectedParentVersionId'] = expectedMetadataParentVersionId
      } else {
        const incomingBranches = (metadata as { branches?: unknown }).branches
        if (Array.isArray(incomingBranches) && incomingBranches.length > 0) {
          params.ConditionExpression = 'attribute_not_exists(metadata.branches)'
        }
      }

      promises.push(
        this.client.send(new UpdateCommand(params))
      )
    }

    const accountSettingsUpdates: string[] = []
    const accountSettingsValues: Record<string, unknown> = {}

    if (pushSubscriptions) {
      accountSettingsUpdates.push('pushSubscriptions = :pushSubscriptions')
      accountSettingsValues[':pushSubscriptions'] = pushSubscriptions
    }
    if (typeof reminderEnabled === 'boolean') {
      accountSettingsUpdates.push('reminderEnabled = :reminderEnabled')
      accountSettingsValues[':reminderEnabled'] = reminderEnabled
    }
    if (typeof reminderTime === 'string') {
      accountSettingsUpdates.push('reminderTime = :reminderTime')
      accountSettingsValues[':reminderTime'] = reminderTime
    }
    if (typeof reminderTimezone === 'string') {
      accountSettingsUpdates.push('reminderTimezone = :reminderTimezone')
      accountSettingsValues[':reminderTimezone'] = reminderTimezone
    }
    if (typeof lastPrayerCompletedAt === 'number') {
      accountSettingsUpdates.push('lastPrayerCompletedAt = :lastPrayerCompletedAt')
      accountSettingsValues[':lastPrayerCompletedAt'] = lastPrayerCompletedAt
    }

    if (accountSettingsUpdates.length > 0) {
      promises.push(
        this.client.send(new UpdateCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: `SET ${accountSettingsUpdates.join(', ')}`,
          ExpressionAttributeValues: accountSettingsValues,
        }))
      )
    }

    const results = await Promise.allSettled(promises)
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason
      }
    }
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

  /**
  * setMany: batch set with conditional branch parent enforcement.
   */
  async setMany(items: VaultItem[]): Promise<void> {
    if (items.length === 0) {
      return
    }

    const transactItems: Array<any> = []

    for (const rawItem of items) {
      const item = rawItem as WritableVaultItem
      const itemToPersist = this._stripTransientFields(item)
      const putParams = getItemPutParams(itemToPersist, item._expectedParentVersionId)
      transactItems.push({ Put: putParams })
    }

    // Execute in chunks
    const chunks = this._chunkTransactItems(transactItems)
    for (const chunk of chunks) {
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: chunk,
        }))
      } catch (error) {
        if (isTransactionCanceled(error)) {
          const reasons = getTransactionCancellationReasons(error)

          const conflictedIds = reasons
            .map((reason, index) => {
              const item = chunk[index]
              if (reason?.Code === 'ConditionalCheckFailed') {
                if (item?.Put) return (item.Put.Item as VaultItem)?.item
              }
              return undefined
            })
            .filter((id): id is string => typeof id === 'string')

          if (conflictedIds.length > 0) {
            throw new TransactionConflictsError(conflictedIds)
          }

          // Some local Dynamo variants omit cancellation reasons.
          // Treat transaction cancellation as a conflict for these writes.
          const chunkIds = chunk
            .map(transaction => {
              if (transaction?.Put) {
                return (transaction.Put.Item as VaultItem)?.item
              }
              return undefined
            })
            .filter((id): id is string => typeof id === 'string')

          throw new TransactionConflictsError(chunkIds)
        }
        throw error
      }
    }
  }

  private _stripTransientFields(item: WritableVaultItem): VaultItem {
    const persisted = { ...item }
    delete persisted._expectedParentVersionId
    return persisted
  }

  /**
   * Chunk mixed Put/Update operations for transaction write
   */
  private _chunkTransactItems(
    items: Array<any>,
  ): Array<Array<any>> {
    const chunks: Array<Array<any>> = []
    let currentChunk: Array<any> = []
    let currentChunkByteSize = 0

    for (const item of items) {
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
      const shouldSplitChunk = currentChunk.length > 0 && (
        currentChunk.length === MAX_TRANSACTION_ITEMS
        || currentChunkByteSize + itemBytes >= MAX_TRANSACTION_BYTES
      )

      if (shouldSplitChunk) {
        chunks.push(currentChunk)
        currentChunk = []
        currentChunkByteSize = 0
      }

      currentChunk.push(item)
      currentChunkByteSize += itemBytes
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk)
    }

    return chunks
  }

  /**
   * Resolve multiple branches for an item by replacing them with a single merged branch
   * Used when a client detects and merges multiple branches
   */
  async resolveBranchConflict(
    account: string,
    itemId: string,
    resolvedBranch: {
      encryptedAutomergeDoc: string
      versionId: string
      parentIds: string[]
    },
  ): Promise<void> {
    const params: UpdateCommandInput = {
      TableName: ITEM_TABLE_NAME,
      Key: { account, item: itemId },
      UpdateExpression: 'SET branches = :newBranch, metadata.modified = :modified',
      ExpressionAttributeValues: {
        ':newBranch': [resolvedBranch],
        ':modified': new Date().getTime(),
      },
      ConditionExpression: 'attribute_exists(item)',
    }

    try {
      await this.client.send(new UpdateCommand(params))
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new Error(`Item not found: ${itemId}`)
      }
      throw error
    }
  }

  async get({ account, item }: VaultKey) {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ITEM_TABLE_NAME,
        Key: { account, item },
        ProjectionExpression: DATA_ATTRIBUTES.join(','),
      },
    ))
    if (response?.Item) {
      return response.Item as VaultItem
    } else {
      throw new Error(`Could not find item (${item}) for this account (${account})`)
    }
  }

  async fetchMany(
    {
      account,
      ids,
    }: {
      account: string,
      ids: string[],
    },
  ) {
    if (ids.length === 0) {
      return []
    }

    // DynamoDB BatchGet rejects duplicate keys in one request.
    // Keep ordering stable via uniqueIds and rehydrate from a map.
    const uniqueIds = Array.from(new Set(ids))
    const keyChunks = chunkKeys(uniqueIds, MAX_BATCH_GET_ITEMS)
    const itemsById = new Map<string, VaultItem>()

    for (const keyChunk of keyChunks) {
      let remainingKeys = keyChunk.map(item => ({ account, item }))
      let retryCount = 0

      while (remainingKeys.length > 0) {
        const response = await this.client.send(new BatchGetCommand({
          RequestItems: {
            [ITEM_TABLE_NAME]: {
              Keys: remainingKeys,
            },
          },
        }))

        const fetchedItems = response.Responses?.[ITEM_TABLE_NAME] as VaultItem[] | undefined
        if (fetchedItems) {
          for (const item of fetchedItems) {
            if (item.item) {
              itemsById.set(item.item, item)
            }
          }
        }

        const unprocessed = response.UnprocessedKeys?.[ITEM_TABLE_NAME]?.Keys as Array<{ account: string, item: string }> | undefined
        if (!unprocessed || unprocessed.length === 0) {
          break
        }

        retryCount += 1
        if (retryCount > MAX_BATCH_GET_RETRIES) {
          throw new Error(`BatchGet exceeded retry limit (${MAX_BATCH_GET_RETRIES}) with ${unprocessed.length} unprocessed keys`)
        }

        // Exponential backoff with jitter for provisioned throughput spikes.
        const backoffMs = Math.min(1000, 50 * (2 ** (retryCount - 1))) + Math.floor(Math.random() * 25)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        remainingKeys = unprocessed
      }
    }

    return uniqueIds
      .map(itemId => itemsById.get(itemId))
      .filter((item): item is VaultItem => !!item)
  }

  async putHistory(data: VaultItemHistory): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: ITEM_HISTORY_TABLE,
        Item: data,
      }))
    } catch (error) {
      if (shouldIgnoreHistoryError(error)) {
        return
      }
      throw error
    }
  }

  async fetchHistory(account: string, itemId: string, limit = 20): Promise<VaultItem[]> {
    let response
    try {
      response = await this.client.send(new QueryCommand({
        TableName: ITEM_HISTORY_TABLE,
        KeyConditionExpression: 'account = :accountid AND begins_with(historyKey, :historyPrefix)',
        ExpressionAttributeValues: {
          ':accountid': account,
          ':historyPrefix': `${itemId}#`,
        },
        ScanIndexForward: false,
        Limit: limit,
      }))
    } catch (error) {
      if (shouldIgnoreHistoryError(error)) {
        return []
      }
      throw error
    }

    const rows = response.Items as VaultItemHistory[] | undefined
    if (!rows || rows.length === 0) {
      return []
    }

    return rows
      .map(row => row.itemData)
      .filter((item): item is VaultItem => !!item)
  }

  async archiveAndReplaceTransaction(input: ArchiveAndReplaceInput): Promise<void> {
    const replacementWritable = input.replacement as WritableVaultItem
    const replacementItem = this._stripTransientFields(replacementWritable)
    const replacementPut = getItemPutParams(replacementItem, replacementWritable._expectedParentVersionId)

    const transactItems = [
      {
        Put: {
          TableName: ITEM_HISTORY_TABLE,
          Item: input.history,
        },
      },
      {
        Put: replacementPut,
      },
    ]

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: transactItems,
      }))
    } catch (error) {
      if (isTransactionCanceled(error) || isConditionalCheckFailure(error)) {
        throw new VersionConflictError('Version conflict: The item has been modified by another client.')
      }
      throw error
    }
  }

  async archiveAndSetManyTransaction(input: ArchiveAndSetManyInput): Promise<void> {
    const historyWrites = input.historyEntries.map(entry => ({
      Put: {
        TableName: ITEM_HISTORY_TABLE,
        Item: entry,
      },
    }))

    const replacementWrites = input.replacements.map(rawItem => {
      const item = rawItem as WritableVaultItem
      const persisted = this._stripTransientFields(item)
      const putParams = getItemPutParams(persisted, item._expectedParentVersionId)
      return {
        Put: putParams,
      }
    })

    const transactItems = [...historyWrites, ...replacementWrites]
    if (transactItems.length === 0) {
      return
    }

    const chunks = this._chunkTransactItems(transactItems)
    for (const chunk of chunks) {
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: chunk,
        }))
      } catch (error) {
        if (isTransactionCanceled(error) || isConditionalCheckFailure(error)) {
          const conflictIds = chunk
            .map(entry => {
              if (entry?.Put?.TableName === ITEM_TABLE_NAME) {
                return (entry.Put.Item as VaultItem | undefined)?.item
              }
              return undefined
            })
            .filter((id): id is string => typeof id === 'string')

          if (conflictIds.length > 0) {
            throw new TransactionConflictsError(conflictIds)
          }

          throw new VersionConflictError('Version conflict: The item has been modified by another client.')
        }
        throw error
      }
    }
  }

  async fetchAll(
    {
      account,
      cacheTime,
    }: {
      account: string,
      cacheTime?: number,
    },
  ): Promise<CachedVaultItem[]> {
    const items: VaultItem[] = []
    let lastEvaluatedKey: QueryCommandOutput['LastEvaluatedKey'] | undefined = undefined

    const projectionExpression = ['#itemKey', ...DATA_ATTRIBUTES].join(',')

    const isDeltaSync = typeof cacheTime === 'number'
    let useDeltaIndex = isDeltaSync

    while (items.length < MAX_ITEMS_FETCH) {
      let queryInput: QueryCommandInput
      if (useDeltaIndex) {
        queryInput = {
          TableName: ITEM_TABLE_NAME,
          IndexName: 'AccountModifiedIndex',
          KeyConditionExpression: 'account = :accountid AND #metadata.#modified > :cacheTime',
          ExpressionAttributeNames: {
            '#itemKey': 'item',
            '#metadata': 'metadata',
            '#modified': 'modified',
          },
          ExpressionAttributeValues: {
            ':accountid': account,
            ':cacheTime': cacheTime,
          },
          ProjectionExpression: projectionExpression,
          ExclusiveStartKey: lastEvaluatedKey,
        }
      } else {
        queryInput = {
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
      }

      let response: QueryCommandOutput
      try {
        response = await this.client.send(new QueryCommand(queryInput))
      } catch (error) {
        if (useDeltaIndex && isMissingDeltaIndexError(error)) {
          useDeltaIndex = false
          lastEvaluatedKey = undefined
          items.length = 0
          continue
        }
        throw error
      }

      if (response?.Items) {
        items.push(...response?.Items as VaultItem[])
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
      if (!lastEvaluatedKey) {
        break
      }
    }

    if (isDeltaSync && !useDeltaIndex) {
      return items
        .filter(item => (item.metadata?.modified || 0) > (cacheTime || 0)) as CachedVaultItem[]
    }

    return items as CachedVaultItem[]
  }

  async delete({ account, item }: VaultKey) {
    await this.client.send(new DeleteCommand({
      TableName: ITEM_TABLE_NAME,
      Key: { account, item },
    }))
  }

  async claimIdempotencyKey(account: string, idempotencyKey: string, expiresAt: number): Promise<boolean> {
    const scopedIdempotencyKey = `${account}:${idempotencyKey}`
    try {
      await this.client.send(new PutCommand({
        TableName: IDEMPOTENCY_TABLE_NAME,
        Item: {
          idempotencyKey: scopedIdempotencyKey,
          account,
          expiresAt,
          createdAt: Date.now(),
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }))
      return true
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        return false
      }
      throw error
    }
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
