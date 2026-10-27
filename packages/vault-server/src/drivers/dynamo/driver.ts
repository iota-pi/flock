import {
  CreateTableCommand,
  DynamoDBClient,
  DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  BatchGetCommandInput,
  BatchWriteCommand,
  BatchWriteCommandInput,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  PutCommandOutput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommand,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb'
import { chunk } from 'lodash-es'
import { addSessionRecord, normalizeSessionRecords, renewSessionRecord } from '../../sessions'
import type {
  AuthData,
  BaseData,
  GetGlobalSyncMessagesInput,
  GetSyncMessagesInput,
  GlobalSyncMessagesPage,
  ItemFormatSummary,
  StoredAccount,
  StoredSyncMessage,
  UpdateAccountDataParams,
  VaultAccount,
  ValidatePageTokenInput,
  VaultDriver,
  VaultItem,
  VaultSessionRecord,
  PushSyncMessagesInput,
  SyncMessagesPage,
} from '../vaultDriver'
import { AuthenticationError } from '../../errors'
import { FAILED_LOGIN_WINDOW_MS } from '../../loginThrottle'
import {
  backOff,
  VersionConflictError,
  type BackoffOptions,
  type ItemId,
  type ManifestEntry,
  type PageToken,
} from '@vault/shared'
import { isConditionalCheckFailure, isResourceInUseError } from './dynamoErrors'
import { getConnectionParams, resolveVaultTableNames, type VaultTableNames } from './config'
import { ACCOUNT_CURSOR_INDEX, getVaultTableDefinitions } from './tables'
import { buildUpdateParams, cursorKeyCondition, projection, RawUpdateValue } from './expressions'
import { sendBatchWithRetry } from './batchRetry'
import { decodeGlobalPageToken, decodeItemPageToken, encodePageToken } from './pageTokens'
import { decodeStoredSnapshotCipher, toStoredItem, validateItem } from './items'
import { parseSyncId, toSyncId } from './syncIds'

export interface DynamoDriverOptions {
  tables?: Partial<VaultTableNames>
  /** App-specific fields written to every new account record */
  accountDefaults?: Record<string, unknown>
}

const SYNC_MESSAGE_TTL = 90 * 24 * 60 * 60
const PUSH_BATCH_SIZE = 25
const FETCH_BATCH_SIZE = 100
export const SYNC_MESSAGE_PAGE_SIZE = 200

const ITEM_DATA_PROJECTION = projection(['item', 'metadata', 'cipher', 'snapshot', 'version'])

const MAX_SESSION_UPDATE_ATTEMPTS = 3
const SESSION_UPDATE_BACKOFF: BackoffOptions = { baseMs: 10, maxMs: 100, jitterMs: 10 }

export default class DynamoDriver implements VaultDriver {
  private internalClient: DynamoDBDocumentClient | undefined
  readonly tables: VaultTableNames
  private readonly accountDefaults: Record<string, unknown>

  constructor(options: DynamoDriverOptions = {}) {
    this.tables = resolveVaultTableNames(options.tables)
    this.accountDefaults = options.accountDefaults ?? {}
  }

  get client() {
    if (!this.internalClient) {
      throw new Error('Cannot use client before initialisation')
    }
    return this.internalClient
  }

  /** Creates any of the vault's tables that don't exist yet */
  async init(): Promise<this> {
    for (const table of getVaultTableDefinitions(this.tables)) {
      try {
        console.info(`Create table: ${table.TableName}`)
        await this.client.send(new CreateTableCommand({ ...table, BillingMode: 'PAY_PER_REQUEST' }))
        console.info(`Table created: ${table.TableName}`)
      } catch (err: unknown) {
        if (!isResourceInUseError(err)) {
          throw err
        }
        console.info(`Table already exists, skipping: ${table.TableName}`)
      }
    }

    return this
  }

  connect(options?: DynamoDBClientConfig, devMode = false): this {
    const connectionParams = getConnectionParams(options)
    const ddb = new DynamoDBClient({
      ...connectionParams,
      logger: devMode ? console : undefined,
    })
    this.internalClient = DynamoDBDocumentClient.from(ddb, {
      marshallOptions: {
        // Some item fields are optional and can be undefined (for example metadata.deleted).
        // Strip them before marshalling to avoid runtime 500s from util-dynamodb.
        removeUndefinedValues: true,
      },
    })
    return this
  }

  async createAccount(
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
    const created = await this.sendConditional(new PutCommand({
      TableName: this.tables.accounts,
      Item: {
        ...this.accountDefaults,
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

  async getAccountRecord({ account }: BaseData): Promise<StoredAccount | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tables.accounts,
      Key: { account },
      // Logging in straight after creating an account reads it first
      ConsistentRead: true,
    }))
    return response?.Item as StoredAccount | undefined
  }

  async recordFailedLogin({ account }: BaseData): Promise<void> {
    const now = Date.now()
    const values = { ':one': 1, ':windowStart': now - FAILED_LOGIN_WINDOW_MS }
    // Count within the current window. The conditions keep both writes from creating an item for an
    // account that doesn't exist.
    const counted = await this.sendConditional(new UpdateCommand({
      TableName: this.tables.accounts,
      Key: { account },
      UpdateExpression: 'ADD failedLogins :one',
      ConditionExpression: 'attribute_exists(account) AND failedLoginsSince > :windowStart',
      ExpressionAttributeValues: values,
    }))
    if (counted) {
      return
    }
    // Or start a new window. If a concurrent failure started it first, this one goes uncounted.
    await this.sendConditional(new UpdateCommand({
      TableName: this.tables.accounts,
      Key: { account },
      UpdateExpression: 'SET failedLogins = :one, failedLoginsSince = :now',
      ConditionExpression:
        'attribute_exists(account) AND (attribute_not_exists(failedLoginsSince) OR failedLoginsSince <= :windowStart)',
      ExpressionAttributeValues: { ...values, ':now': now },
    }))
  }

  async updateAccountData<TExtra extends object = Record<never, never>>({
    account,
    expectedKeyringVersion,
    sessions,
    ...rest
  }: UpdateAccountDataParams & Partial<TExtra>): Promise<void> {
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
      await this.client.send(new UpdateCommand({
        TableName: this.tables.accounts,
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

  async addSession({ account, session, expiry }: AuthData & { expiry: number }): Promise<void> {
    const added = await this.updateSessions(account, activeSessions => addSessionRecord(activeSessions, session, expiry))
    if (!added) {
      throw new Error(`Could not add a session to account ${account}`)
    }
  }

  async extendSession({ account, session }: AuthData): Promise<void> {
    await this.updateSessions(account, (activeSessions, now, attempt) => (
      renewSessionRecord(activeSessions, session, now, attempt > 0)
    ))
  }

  /**
   * Rewrites the account's sessions on condition that they haven't changed since they were read,
   * retrying when a concurrent login, renewal or password change got there first. `update` gets the
   * active sessions and returns the new list, or undefined to leave them as they are. Returns whether
   * it wrote.
   */
  private async updateSessions(
    account: string,
    update: (activeSessions: VaultSessionRecord[], now: number, attempt: number) => VaultSessionRecord[] | undefined,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_SESSION_UPDATE_ATTEMPTS; attempt += 1) {
      const record = await this.getAccountRecord({ account })
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
      const written = await this.sendConditional(new UpdateCommand({
        TableName: this.tables.accounts,
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

  async set(item: VaultItem): Promise<{ version: number }> {
    const itemToPersist = toStoredItem(item)

    // Measured as stored, with the snapshot in binary. Clients limit its base64 text, which is
    // longer, so the server never rejects a snapshot that a client's own size check let through.
    validateItem(itemToPersist)

    // Deletion is terminal. A snapshot from a device that hasn't seen the delete yet still replaces
    // the stored one (hydration merges, so that is harmless), but must keep the item deleted.
    if (itemToPersist.metadata.deleted !== true) {
      const written = await this.sendConditional(this.updateItemCommand(itemToPersist, { unlessDeleted: true }))
      if (written) {
        return readVersion(written)
      }
    }
    const tombstone = { ...itemToPersist, metadata: { ...itemToPersist.metadata, deleted: true } }
    return readVersion(await this.client.send(this.updateItemCommand(tombstone)))
  }

  /** Writes an item and bumps its version. With `unlessDeleted`, the write fails its condition on a tombstone. */
  private updateItemCommand(item: VaultItem, { unlessDeleted = false } = {}): UpdateCommand {
    const modifiedAt = typeof item.metadata?.modified === 'number'
      ? item.metadata.modified
      : Date.now()
    // A snapshot supersedes the legacy payload, which nothing reads once a snapshot exists
    const removeLegacyCipher = !!item.snapshot && !item.cipher

    return new UpdateCommand({
      TableName: this.tables.items,
      Key: {
        account: item.account,
        item: item.item,
      },
      ...buildUpdateParams({
        set: {
          metadata: item.metadata,
          snapshot: item.snapshot || undefined,
          cipher: item.cipher || undefined,
          modifiedAt,
          version: new RawUpdateValue('if_not_exists(#version, :zero) + :one', { ':zero': 0, ':one': 1 }),
        },
        remove: removeLegacyCipher ? ['cipher'] : [],
        // Older rows may mark deletion with a top-level attribute, which the manifest also reads
        condition: unlessDeleted
          ? {
            expression: '(attribute_not_exists(#metadata.#deleted) OR #metadata.#deleted <> :true)'
              + ' AND (attribute_not_exists(#deleted) OR #deleted <> :true)',
            names: { '#deleted': 'deleted' },
            values: { ':true': true },
          }
          : undefined,
      }),
      ReturnValues: 'UPDATED_NEW',
    })
  }

  async fetchManifest({ account }: BaseData): Promise<ManifestEntry[]> {
    const manifest: ManifestEntry[] = []
    const records = this.queryAll({
      TableName: this.tables.items,
      ...cursorKeyCondition('account', account, undefined),
      ...projection(['item', 'version', 'modifiedAt', 'metadata.modified', 'metadata.deleted', 'deleted']),
    })

    for await (const record of records) {
      const itemId = readItemId(record)
      if (!itemId) continue
      const isDeleted = record.metadata?.deleted === true || record.deleted === true
      const modifiedAt = typeof record.modifiedAt === 'number'
        ? record.modifiedAt
        : (typeof record.metadata?.modified === 'number' ? record.metadata.modified : 0)
      const version = typeof record.version === 'number' ? record.version : 1
      manifest.push({
        itemId,
        version,
        modifiedAt,
        ...(isDeleted ? { isDeleted: true } : {}),
      })
    }

    return manifest
  }

  async raiseDataVersion({ account, dataVersion }: BaseData & { dataVersion: number }): Promise<void> {
    // The condition fails when the account is already at this version or higher
    await this.sendConditional(new UpdateCommand({
      TableName: this.tables.accounts,
      Key: { account },
      UpdateExpression: 'SET dataVersion = :dataVersion',
      ConditionExpression: 'attribute_exists(account) AND (attribute_not_exists(dataVersion) OR dataVersion < :dataVersion)',
      ExpressionAttributeValues: {
        ':dataVersion': dataVersion,
      },
    }))
  }

  async listItemFormats({ account }: BaseData): Promise<ItemFormatSummary[]> {
    const formats: ItemFormatSummary[] = []
    const records = this.queryAll({
      TableName: this.tables.items,
      ...cursorKeyCondition('account', account, undefined),
      ...projection(['item', 'metadata.deleted', 'snapshot.iv', 'snapshot.format', 'snapshot.kver', 'cipher']),
    })

    for await (const record of records) {
      const itemId = readItemId(record)
      if (!itemId) continue
      const snapshotFormat = record.snapshot?.format
      const snapshotKver = record.snapshot?.kver
      formats.push({
        itemId,
        deleted: record.metadata?.deleted === true,
        hasSnapshot: record.snapshot !== undefined,
        ...(typeof snapshotFormat === 'number' ? { snapshotFormat } : {}),
        ...(typeof snapshotKver === 'string' ? { snapshotKver } : {}),
        hasCipher: typeof record.cipher === 'string' && record.cipher.length > 0,
      })
    }

    return formats
  }

  /** Sends a conditional write. Resolves to undefined, instead of throwing, when the condition fails. */
  private async sendConditional(command: PutCommand): Promise<PutCommandOutput | undefined>
  private async sendConditional(command: UpdateCommand): Promise<UpdateCommandOutput | undefined>
  private async sendConditional(command: PutCommand | UpdateCommand) {
    try {
      // `send` takes one command type at a time; the overloads above give each caller its output type
      return await this.client.send(command as UpdateCommand)
    } catch (error) {
      if (!isConditionalCheckFailure(error)) {
        throw error
      }
      return undefined
    }
  }

  /** Runs a query to the end, yielding the records of each page as it arrives */
  private async* queryAll(input: Omit<QueryCommandInput, 'ExclusiveStartKey'>): AsyncGenerator<NonNullable<QueryCommandOutput['Items']>[number]> {
    let exclusiveStartKey: QueryCommandOutput['LastEvaluatedKey']
    do {
      const response = await this.client.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }))
      yield* response.Items ?? []
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
  }

  private async executeBatchGetWithRetry(
    requestItems: BatchGetCommandInput['RequestItems'],
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const accumulatedResponses: Record<string, Record<string, unknown>[]> = {}
    await sendBatchWithRetry({
      request: requestItems,
      commandName: 'BatchGetCommand',
      unprocessedName: 'keys',
      send: async request => {
        const response = await this.client.send(new BatchGetCommand({ RequestItems: request }))
        for (const [tableName, items] of Object.entries(response.Responses ?? {})) {
          accumulatedResponses[tableName] ??= []
          accumulatedResponses[tableName].push(...items)
        }
        return response.UnprocessedKeys
      },
    })
    return accumulatedResponses
  }

  async fetchByIds({ account, itemIds }: BaseData & { itemIds: ItemId[] }): Promise<VaultItem[]> {
    if (itemIds.length === 0) {
      return []
    }

    const uniqueItemIds = Array.from(new Set(itemIds))
    const batches = chunk(uniqueItemIds, FETCH_BATCH_SIZE)
    const results: VaultItem[] = []

    for (const batch of batches) {
      const requestItems: BatchGetCommandInput['RequestItems'] = {
        [this.tables.items]: {
          Keys: batch.map(itemId => ({
            account,
            item: itemId,
          })),
          ...ITEM_DATA_PROJECTION,
        },
      }
      const responses = await this.executeBatchGetWithRetry(requestItems)
      const items = responses[this.tables.items] as VaultItem[] | undefined
      if (items) {
        results.push(...items)
      }
    }

    results.forEach(decodeStoredSnapshotCipher)
    return results
  }

  private async executeBatchWriteWithRetry(
    requestItems: BatchWriteCommandInput['RequestItems'],
  ): Promise<void> {
    await sendBatchWithRetry({
      request: requestItems,
      commandName: 'BatchWriteCommand',
      unprocessedName: 'items',
      send: async request => {
        const response = await this.client.send(new BatchWriteCommand({ RequestItems: request }))
        return response.UnprocessedItems
      },
    })
  }

  async pushSyncMessagesBatch(input: PushSyncMessagesInput): Promise<void> {
    const batches = chunk(input.messages, PUSH_BATCH_SIZE)

    await Promise.all(
      batches.map(async batch => {
        const requestItems: BatchWriteCommandInput['RequestItems'] = {
          [this.tables.syncMessages]: batch.map(message => ({
            PutRequest: {
              Item: {
                syncId: toSyncId(input.account, message.itemId),
                cursor: message.entry.cursor,
                account: input.account,
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

  async getSyncMessages(input: GetSyncMessagesInput): Promise<SyncMessagesPage> {
    const expectedSyncId = toSyncId(input.account, input.itemId)
    const { items, hasMore, nextPageToken } = await this.querySyncMessagePage({
      partitionKey: 'syncId',
      partitionValue: expectedSyncId,
      afterCursor: input.fromCursor,
      startKey: input.pageToken
        ? decodeItemPageToken(input.pageToken, expectedSyncId, input.fromCursor)
        : undefined,
    })
    return { messages: items as StoredSyncMessage[], hasMore, nextPageToken }
  }

  validatePageToken(input: ValidatePageTokenInput): void {
    if (input.itemId) {
      decodeItemPageToken(input.pageToken, toSyncId(input.account, input.itemId), input.cursor)
    } else {
      decodeGlobalPageToken(input.pageToken, input.account)
    }
  }

  async getGlobalSyncMessagesAfterCursor(input: GetGlobalSyncMessagesInput): Promise<GlobalSyncMessagesPage> {
    const messagesByItem = new Map<ItemId, StoredSyncMessage[]>()

    const startKey = input.pageToken
      ? decodeGlobalPageToken(input.pageToken, input.account)
      : undefined
    const { items, hasMore, nextPageToken } = await this.querySyncMessagePage({
      indexName: ACCOUNT_CURSOR_INDEX,
      partitionKey: 'account',
      partitionValue: input.account,
      afterCursor: input.cursor,
      startKey,
    })

    // Highest cursor examined by this page (before any caller-side filtering), so clients can
    // track the global scan position independently of per-item cursors.
    let scannedThroughCursor = startKey?.cursor ?? input.cursor ?? 0

    for (const item of items as (StoredSyncMessage & { syncId: string })[]) {
      if (typeof item.cursor === 'number' && item.cursor > scannedThroughCursor) {
        scannedThroughCursor = item.cursor
      }
      const itemId = parseSyncId(item.syncId)?.itemId
      if (!itemId) continue

      let messages = messagesByItem.get(itemId)
      if (!messages) {
        messages = []
        messagesByItem.set(itemId, messages)
      }
      messages.push({
        cursor: item.cursor,
        encryptedMessage: item.encryptedMessage,
        createdAt: item.createdAt,
      })
    }

    return {
      items: Array.from(messagesByItem.entries()).map(([itemId, messages]) => ({
        itemId,
        messages: messages.sort((a, b) => a.cursor - b.cursor),
      })),
      hasMore,
      nextPageToken,
      scannedThroughCursor,
    }
  }

  /**
   * Queries one page of a partition's sync messages: from the decoded page token when there is one,
   * otherwise after `afterCursor`
   */
  private async querySyncMessagePage({
    indexName,
    partitionKey,
    partitionValue,
    afterCursor,
    startKey,
  }: {
    indexName?: string
    partitionKey: string
    partitionValue: string
    afterCursor: number | undefined
    startKey: Record<string, unknown> | undefined
  }): Promise<{ items: Record<string, unknown>[], hasMore: boolean, nextPageToken?: PageToken }> {
    const response = await this.client.send(new QueryCommand({
      TableName: this.tables.syncMessages,
      IndexName: indexName,
      // A continuation starts from the token, which already lies after the cursor
      ...cursorKeyCondition(partitionKey, partitionValue, startKey ? undefined : afterCursor),
      Limit: SYNC_MESSAGE_PAGE_SIZE,
      ExclusiveStartKey: startKey,
    }))
    return {
      items: response.Items ?? [],
      hasMore: !!response.LastEvaluatedKey,
      nextPageToken: response.LastEvaluatedKey ? encodePageToken(response.LastEvaluatedKey) : undefined,
    }
  }
}

/** The version that a write to the items table returned */
function readVersion(response: UpdateCommandOutput): { version: number } {
  return { version: (response.Attributes?.version as number) ?? 1 }
}

/** The item ID of an items-table record, or undefined for a record without one */
function readItemId(record: Record<string, unknown>): ItemId | undefined {
  return typeof record.item === 'string' && record.item !== '' ? record.item as ItemId : undefined
}
