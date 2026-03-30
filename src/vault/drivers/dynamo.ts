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
  AuthData,
  BaseData,
  CachedVaultItem,
  VaultAccountWithAuth,
  VaultItem,
  VaultKey,
} from './base'
import type { WebPushSubscription } from '../types'
import { ExpiredSessionError } from '../api/errors'

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts'
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems'
const DATA_ATTRIBUTES = ['metadata', 'cipher']

export const MAX_ITEM_SIZE = 50000
export const MAX_ITEMS_FETCH = 5000
export const MAX_TRANSACTION_ITEMS = 100
export const MAX_TRANSACTION_BYTES = 3_500_000
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
export const ITEM_TTL_SECONDS = 30 * 24 * 60 * 60

type WritableVaultItem = VaultItem & {
  _fastForward?: boolean
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

function getItemPutParams(item: VaultItem): PutCommandInput {
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

  if (typeof persistedItem.metadata.version === 'number') {
    params.ConditionExpression = 'attribute_not_exists(#item) OR attribute_not_exists(metadata.version) OR metadata.version < :newVersion'
    params.ExpressionAttributeNames = {
      '#item': 'item',
    }
    params.ExpressionAttributeValues = {
      ':newVersion': persistedItem.metadata.version,
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
      if (!(error instanceof ConditionalCheckFailedException)) {
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
    }: Partial<AuthData> & {
      metadata?: Record<string, unknown>,
      pushSubscriptions?: WebPushSubscription[],
      reminderEnabled?: boolean,
      reminderTime?: string,
      session?: string,
      reminderTimezone?: string,
      lastPrayerCompletedAt?: number,
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

      if (typeof metadata.version === 'number') {
        params.ConditionExpression = 'attribute_not_exists(metadata.version) OR metadata.version < :newVersion'
        params.ExpressionAttributeValues![':newVersion'] = metadata.version
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
    const params = getItemPutParams(item)

    try {
      await this.client.send(new PutCommand(params))
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new Error('Version conflict: The item has been modified by another client.')
      }
      throw err
    }
  }

  /**
   * setMany: batch set with branch appending support
   *
   * If _fastForward is explicitly false and branches are present, append incoming
   * branches to current branches using list_append. Otherwise perform a put/overwrite.
   */
  async setMany(items: VaultItem[]): Promise<void> {
    if (items.length === 0) {
      return
    }

    const transactItems: Array<any> = []

    for (const rawItem of items) {
      const item = rawItem as WritableVaultItem
      const shouldAppendBranches = item._fastForward === false && !!item.branches && item.branches.length > 0
      const itemToPersist = this._stripTransientFields(item)

      if (shouldAppendBranches) {
        const updateParams = this._getItemAppendBranchesParams(itemToPersist)
        transactItems.push({ Update: updateParams })
      } else {
        const putParams = getItemPutParams(itemToPersist)
        transactItems.push({ Put: putParams })
      }
    }

    // Execute in chunks
    const chunks = this._chunkTransactItems(transactItems)
    for (const chunk of chunks) {
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: chunk,
        }))
      } catch (error) {
        if (error instanceof TransactionCanceledException) {
          const reasons = ((error as unknown as {
            CancellationReasons?: Array<{ Code?: string }>
            cancellationReasons?: Array<{ Code?: string }>
          }).CancellationReasons
            || (error as unknown as {
              CancellationReasons?: Array<{ Code?: string }>
              cancellationReasons?: Array<{ Code?: string }>
            }).cancellationReasons
            || [])

          const conflictedIds = reasons
            .map((reason, index) => {
              const item = transactItems[index]
              if (reason?.Code === 'ConditionalCheckFailed') {
                if (item?.Put) return (item.Put.Item as VaultItem)?.item
                if (item?.Update) {
                  const key = item.Update.Key as Record<string, any>
                  return key?.item
                }
              }
              return undefined
            })
            .filter((id): id is string => typeof id === 'string')

          if (conflictedIds.length > 0) {
            throw new TransactionConflictsError(conflictedIds)
          }
        }
        throw error
      }
    }
  }

  private _stripTransientFields(item: WritableVaultItem): VaultItem {
    const persisted = { ...item }
    delete persisted._fastForward
    return persisted
  }

  /**
   * Build UpdateItem parameters for appending branches to existing item
   */
  private _getItemAppendBranchesParams(item: VaultItem): UpdateCommandInput {
    validateItem(item)

    if (!item.branches) {
      throw new Error(`Cannot append branches to item without branches array`)
    }

    const params: UpdateCommandInput = {
      TableName: ITEM_TABLE_NAME,
      Key: {
        account: item.account,
        item: item.item,
      },
      UpdateExpression: 'SET #branches = list_append(if_not_exists(#branches, :emptyBranches), :newBranches), #metadata = :metadata',
      ExpressionAttributeNames: {
        '#branches': 'branches',
        '#metadata': 'metadata',
      },
      ExpressionAttributeValues: {
        ':emptyBranches': [],
        ':newBranches': item.branches,
        ':metadata': item.metadata,
      },
      ConditionExpression: 'attribute_exists(#item)',
    }

    params.ExpressionAttributeNames = {
      ...params.ExpressionAttributeNames,
      '#item': 'item',
    }

    return params
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
    const response = await this.client.send(new BatchGetCommand(
      {
        RequestItems: {
          [ITEM_TABLE_NAME]: {
            Keys: ids.map(item => ({ account, item })) ?? [],
          },
        },
      },
    ))
    return response.Responses?.[ITEM_TABLE_NAME] as VaultItem[] ?? []
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
        if (
          useDeltaIndex
          && error instanceof Error
          && error.message.includes('does not have the specified index')
        ) {
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
