import {
  CreateTableCommand,
  CreateTableCommandInput,
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
  PutCommandInput,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  UpdateCommand,
  UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { chunk } from 'lodash-es'
import { z } from 'zod'
import {
  safeEqual,
  generateAccountId,
} from '../util'
import BaseDriver, {
  AuthData,
  BaseData,
  ItemFormatSummary,
  StoredSyncMessage,
  UpdateAccountDataParams,
  VaultAccount,
  VaultAccountWithAuth,
  VaultItem,
  VaultSessionRecord,
} from './base'
import { ExpiredSessionError, InvalidPageTokenError } from './errors'
import { VersionConflictError, MAX_ITEM_SIZE } from '@vault/shared'
import type { ItemId, ManifestEntry, PageToken } from '@vault/shared'
import {
  isConditionalCheckFailure,
  isResourceInUseError,
  isTransientDynamoError,
} from './dynamoErrors'

export interface VaultTableNames {
  accounts: string
  items: string
  syncMessages: string
}

const TABLE_NAME_ENV_VARS: Record<keyof VaultTableNames, string> = {
  accounts: 'ACCOUNTS_TABLE',
  items: 'ITEMS_TABLE',
  syncMessages: 'SYNC_MESSAGES_TABLE',
}

/**
 * Resolves table names from explicit options, falling back to the ACCOUNTS_TABLE, ITEMS_TABLE
 * and SYNC_MESSAGES_TABLE environment variables.
 */
export function resolveVaultTableNames(tables: Partial<VaultTableNames> = {}): VaultTableNames {
  const resolved = {} as VaultTableNames
  for (const key of Object.keys(TABLE_NAME_ENV_VARS) as Array<keyof VaultTableNames>) {
    const envVar = TABLE_NAME_ENV_VARS[key]
    const name = tables[key] ?? process.env[envVar]
    if (!name) {
      throw new Error(`Missing DynamoDB table name for "${key}". Pass it to DynamoDriver or set ${envVar}.`)
    }
    resolved[key] = name
  }
  return resolved
}

export interface DynamoDriverOptions {
  tables?: Partial<VaultTableNames>
  /** App-specific fields written to every new account record */
  accountDefaults?: Record<string, unknown>
}

const SYNC_MESSAGE_TTL = 90 * 24 * 60 * 60
const PUSH_BATCH_SIZE = 25
const DEFAULT_SYNC_MESSAGE_LIMIT = 200

const DATA_ATTRIBUTES = [
  '#metadata',
  '#cipher',
  '#snapshot',
  '#version',
]
const DATA_ATTRIBUTE_NAMES = {
  '#metadata': 'metadata',
  '#cipher': 'cipher',
  '#snapshot': 'snapshot',
  '#version': 'version',
}

export { MAX_ITEM_SIZE }
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 8

type PersistedVaultItem = VaultItem & {
  modifiedAt?: number
  version?: number
}

/**
 * Validates a VaultItem.
 * Supports both legacy cipher and snapshot format
 * - Legacy: must have cipher and iv
 * - Snapshot: must have snapshot payload or external storage pointer
 * - Tombstone: needs no payload
 */
function validateItem(item: VaultItem) {
  const isTombstone = item.metadata.deleted === true
  const isLegacy = !!item.cipher
  const isSnapshot = !!item.snapshot

  const hasValidPayload = isTombstone
    || (isLegacy ? !!item.metadata.iv : isSnapshot)

  if (!hasValidPayload) {
    throw new Error(
      `Invalid item format: must be either legacy (cipher+iv) or snapshot. Item: ${JSON.stringify(item)}`,
    )
  }

  // Calculate item length without expanding binary Buffers into huge JSON arrays
  let itemLength: number
  const cipher = item.snapshot?.cipher
  if (cipher && (Buffer.isBuffer(cipher) || cipher instanceof Uint8Array)) {
    const cipherLength = cipher.byteLength
    const itemWithoutCipher = {
      ...item,
      snapshot: {
        ...item.snapshot,
        cipher: undefined,
      },
    }
    itemLength = JSON.stringify(itemWithoutCipher).length + cipherLength
  } else {
    itemLength = JSON.stringify(item).length
  }

  if (itemLength > MAX_ITEM_SIZE) {
    throw new Error(`Item length (${itemLength}) exceeds maximum (${MAX_ITEM_SIZE})`)
  }
}

function getItemPutParams(item: VaultItem, tableName: string): PutCommandInput {
  validateItem(item)

  const modifiedAt = typeof item.metadata?.modified === 'number' ? item.metadata.modified : undefined
  const ttl = item.ttl

  const nextVersion = (item.version ?? 0) + 1
  const persistedItem: PersistedVaultItem = {
    ...item,
    version: nextVersion,
    ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
  }

  const params: PutCommandInput = {
    TableName: tableName,
    Item: persistedItem,
    ConditionExpression: typeof item.version === 'number'
      ? 'attribute_not_exists(account) OR version = :expectedVersion'
      : undefined,
    ExpressionAttributeValues: typeof item.version === 'number'
      ? { ':expectedVersion': item.version }
      : undefined,
  }

  return params
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

export function buildDynamoUpdate(fields: Record<string, unknown>): {
  expression: string
  values: Record<string, unknown>
} {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined)
  if (entries.length === 0) {
    return {
      expression: '',
      values: {},
    }
  }
  return {
    expression: `SET ${entries.map(([k]) => `${k} = :${k}`).join(', ')}`,
    values: Object.fromEntries(entries.map(([k, v]) => [`:${k}`, v])),
  }
}

export default class DynamoDriver<T extends DynamoDBClientConfig = DynamoDBClientConfig> extends BaseDriver<T> {
  private internalClient: DynamoDBDocumentClient | undefined
  readonly tables: VaultTableNames
  private readonly accountDefaults: Record<string, unknown>

  constructor(options: DynamoDriverOptions = {}) {
    super()
    this.tables = resolveVaultTableNames(options.tables)
    this.accountDefaults = options.accountDefaults ?? {}
  }

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
    const tablesToEnsure: Pick<CreateTableCommandInput, 'TableName' | 'KeySchema' | 'AttributeDefinitions' | 'GlobalSecondaryIndexes'>[] = [
      {
        TableName: this.tables.items,
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
        TableName: this.tables.accounts,
        KeySchema: [
          { AttributeName: 'account', KeyType: 'HASH' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'account', AttributeType: 'S' },
        ],
      },
      {
        TableName: this.tables.syncMessages,
        KeySchema: [
          { AttributeName: 'syncId', KeyType: 'HASH' },
          { AttributeName: 'cursor', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'syncId', AttributeType: 'S' },
          { AttributeName: 'cursor', AttributeType: 'N' },
          { AttributeName: 'account', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'AccountCursorIndex',
            KeySchema: [
              { AttributeName: 'account', KeyType: 'HASH' },
              { AttributeName: 'cursor', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
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
            GlobalSecondaryIndexes: table.GlobalSecondaryIndexes,
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

  connect(options?: T, devMode = false): DynamoDriver {
    const connectionParams = getConnectionParams(options)
    const ddb = new DynamoDBClient({
      ...connectionParams,
      logger: devMode ? console : undefined,
    })
    this.internalClient = this.getDocumentClient(ddb)
    return this
  }

  async createAccount(
    {
      account,
      authToken,
      salt,
      iterations,
      saltVersion,
    }: VaultAccount,
  ): Promise<boolean> {
    let success = true
    await this.client.send(new PutCommand({
      TableName: this.tables.accounts,
      Item: {
        ...this.accountDefaults,
        account,
        authToken,
        created: Date.now(),
        lastAccess: Date.now(),
        salt,
        iterations,
        saltVersion,
        sessions: [],
        keyringVersion: 1,
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
        TableName: this.tables.accounts,
        Key: { account },
        ConsistentRead: true,
      },
    ))
    if (response?.Item) {
      if (isLogin) {
        // For logins, check authToken instead
        if (safeEqual(session, response.Item.authToken as string)) {
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
      if (activeSessions.some(active => safeEqual(session, active.token))) {
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

  async getSecurityParams({ account }: BaseData): Promise<{ salt: string, iterations?: number, saltVersion?: number, dataVersion?: number }> {
    const response = await this.client.send(new GetCommand(
      {
        TableName: this.tables.accounts,
        Key: { account },
        // Logging in straight after creating an account reads it here first
        ConsistentRead: true,
      },
    ))
    if (response?.Item) {
      const dbAccount = response.Item as VaultAccountWithAuth
      const salt = dbAccount.salt
      const iterations = dbAccount.iterations
      const saltVersion = dbAccount.saltVersion
      const dataVersion = dbAccount.dataVersion

      const returnedSalt = typeof salt === 'string' ? salt : account
      return { salt: returnedSalt, iterations, saltVersion, dataVersion }
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
          TableName: this.tables.accounts,
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

  async updateAccountData<TExtra extends object = Record<never, never>>({
    account,
    expectedKeyringVersion,
    sessions,
    session,
    ...rest
  }: UpdateAccountDataParams & Partial<TExtra>): Promise<void> {
    const updateFields: Record<string, unknown> = {
      ...rest,
      ...(sessions !== undefined ? { sessions: normalizeSessionRecords(sessions) } : {}),
    }

    const { expression, values } = buildDynamoUpdate(updateFields)
    if (!expression) {
      return
    }

    const params: UpdateCommandInput = {
      TableName: this.tables.accounts,
      Key: { account },
      UpdateExpression: expression,
      ExpressionAttributeValues: values,
    }

    if (typeof expectedKeyringVersion === 'number') {
      values[':expectedKeyringVersion'] = expectedKeyringVersion
      params.ConditionExpression = '(keyringVersion = :expectedKeyringVersion OR attribute_not_exists(keyringVersion))'
    }

    await this.client.send(new UpdateCommand(params))
  }

  async extendSession({ account, session }: AuthData): Promise<void> {
    const maxRetries = 3
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.client.send(new GetCommand({
        TableName: this.tables.accounts,
        Key: { account },
        ConsistentRead: true,
      }))

      if (!response?.Item) {
        return
      }

      const rawSessions = response.Item.sessions
      const now = Date.now()
      const activeSessions = normalizeSessionRecords(rawSessions, now)
      const sessionRecord = activeSessions.find(active => safeEqual(session, active.token))
      if (!sessionRecord) {
        return
      }

      // If already extended recently (e.g. by another concurrent request), avoid redundant write
      if (attempt > 0 && sessionRecord.expiry >= now + SESSION_EXPIRY_MS - 60_000) {
        return
      }

      sessionRecord.expiry = now + SESSION_EXPIRY_MS
      const nextSessions = normalizeSessionRecords(activeSessions, now)

      const params: UpdateCommandInput = {
        TableName: this.tables.accounts,
        Key: { account },
        UpdateExpression: 'SET sessions = :sessions, lastAccess = :now',
        ExpressionAttributeValues: {
          ':sessions': nextSessions,
          ':now': now,
        },
      }

      if (Array.isArray(rawSessions)) {
        params.ConditionExpression = 'sessions = :expectedSessions'
        params.ExpressionAttributeValues![':expectedSessions'] = rawSessions
      } else {
        params.ConditionExpression = 'attribute_not_exists(sessions)'
      }

      try {
        await this.client.send(new UpdateCommand(params))
        return
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          if (attempt === maxRetries - 1) {
            return
          }
          const delay = Math.min(10 * Math.pow(2, attempt) + Math.random() * 10, 100)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
        throw error
      }
    }
  }

  async set(item: VaultItem) {
    validateItem(item)

    let itemToPersist = item

    if (item.snapshot?.cipher) {
      let cipherBytes: Buffer
      if (Buffer.isBuffer(item.snapshot.cipher)) {
        cipherBytes = item.snapshot.cipher
      } else if (item.snapshot.cipher instanceof Uint8Array) {
        cipherBytes = Buffer.from(item.snapshot.cipher)
      } else if (typeof item.snapshot.cipher === 'string') {
        cipherBytes = Buffer.from(item.snapshot.cipher, 'base64')
      } else {
        cipherBytes = Buffer.from([])
      }

      // Store inline in DynamoDB as binary Buffer (DynamoDB type 'B')
      itemToPersist = {
        ...item,
        snapshot: {
          iv: item.snapshot.iv,
          kver: item.snapshot.kver,
          ...(item.snapshot.format === undefined ? {} : { format: item.snapshot.format }),
          cipher: cipherBytes,
        },
      }
    }

    if (typeof item.version !== 'number') {
      const modifiedAt = typeof itemToPersist.metadata?.modified === 'number'
        ? itemToPersist.metadata.modified
        : Date.now()
      // A snapshot supersedes the legacy payload, which nothing reads once a snapshot exists
      const removeLegacyCipher = !!itemToPersist.snapshot && !itemToPersist.cipher

      const updateParams: UpdateCommandInput = {
        TableName: this.tables.items,
        Key: {
          account: itemToPersist.account,
          item: itemToPersist.item,
        },
        UpdateExpression: [
          'SET #metadata = :metadata',
          itemToPersist.snapshot ? '#snapshot = :snapshot' : undefined,
          itemToPersist.cipher ? '#cipher = :cipher' : undefined,
          '#modifiedAt = :modifiedAt',
          '#version = if_not_exists(#version, :zero) + :one',
          itemToPersist.ttl !== undefined ? '#ttl = :ttl' : undefined,
        ].filter(Boolean).join(', ') + (removeLegacyCipher ? ' REMOVE #cipher' : ''),
        ExpressionAttributeNames: {
          '#metadata': 'metadata',
          ...(itemToPersist.snapshot ? { '#snapshot': 'snapshot' } : {}),
          ...(itemToPersist.cipher || removeLegacyCipher ? { '#cipher': 'cipher' } : {}),
          '#modifiedAt': 'modifiedAt',
          '#version': 'version',
          ...(itemToPersist.ttl !== undefined ? { '#ttl': 'ttl' } : {}),
        },
        ExpressionAttributeValues: {
          ':metadata': itemToPersist.metadata,
          ...(itemToPersist.snapshot ? { ':snapshot': itemToPersist.snapshot } : {}),
          ...(itemToPersist.cipher ? { ':cipher': itemToPersist.cipher } : {}),
          ':modifiedAt': modifiedAt,
          ':zero': 0,
          ':one': 1,
          ...(itemToPersist.ttl !== undefined ? { ':ttl': itemToPersist.ttl } : {}),
        },
        ReturnValues: 'UPDATED_NEW',
      }

      const res = await this.client.send(new UpdateCommand(updateParams))
      const assignedVersion = (res.Attributes?.version as number) ?? 1
      return { version: assignedVersion }
    }

    const params = getItemPutParams(itemToPersist, this.tables.items)

    try {
      await this.client.send(new PutCommand(params))
      return { version: itemToPersist.version ?? 1 }
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        throw new VersionConflictError('Version conflict: The item has been modified by another client.')
      }
      throw err
    }
  }

  async fetchManifest(
    { account }: { account: string },
  ): Promise<Array<ManifestEntry>> {
    const manifest: Array<ManifestEntry> = []
    let lastEvaluatedKey: QueryCommandOutput['LastEvaluatedKey'] | undefined = undefined

    while (true) {
      const queryInput: QueryCommandInput = {
        TableName: this.tables.items,
        KeyConditionExpression: 'account = :accountid',
        ExpressionAttributeNames: {
          '#itemKey': 'item',
          '#modifiedAt': 'modifiedAt',
          '#metadata': 'metadata',
          '#deleted': 'deleted',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':accountid': account,
        },
        ProjectionExpression: '#itemKey, #version, #modifiedAt, #metadata.modified, #metadata.#deleted, #deleted',
        ExclusiveStartKey: lastEvaluatedKey,
      }

      const response = await this.client.send(new QueryCommand(queryInput))

      if (response?.Items) {
        for (const record of response.Items) {
          const itemId = record.item as ItemId
          if (!itemId) continue
          const isDeleted = record.metadata?.deleted === true || (record as Record<string, unknown>).deleted === true
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
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
      if (!lastEvaluatedKey) {
        break
      }
    }

    return manifest
  }

  async raiseDataVersion({ account, dataVersion }: BaseData & { dataVersion: number }): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tables.accounts,
        Key: { account },
        UpdateExpression: 'SET dataVersion = :dataVersion',
        ConditionExpression: 'attribute_exists(account) AND (attribute_not_exists(dataVersion) OR dataVersion < :dataVersion)',
        ExpressionAttributeValues: {
          ':dataVersion': dataVersion,
        },
      }))
    } catch (error) {
      // Already at this version or higher
      if (!isConditionalCheckFailure(error)) {
        throw error
      }
    }
  }

  async listItemFormats({ account }: BaseData): Promise<ItemFormatSummary[]> {
    const formats: ItemFormatSummary[] = []
    let lastEvaluatedKey: QueryCommandOutput['LastEvaluatedKey'] | undefined = undefined

    do {
      const response: QueryCommandOutput = await this.client.send(new QueryCommand({
        TableName: this.tables.items,
        KeyConditionExpression: 'account = :accountid',
        ExpressionAttributeNames: {
          '#itemKey': 'item',
          '#metadata': 'metadata',
          '#deleted': 'deleted',
          '#snapshot': 'snapshot',
          '#iv': 'iv',
          '#format': 'format',
          '#cipher': 'cipher',
        },
        ExpressionAttributeValues: {
          ':accountid': account,
        },
        ProjectionExpression: '#itemKey, #metadata.#deleted, #snapshot.#iv, #snapshot.#format, #cipher',
        ExclusiveStartKey: lastEvaluatedKey,
      }))

      for (const record of response.Items ?? []) {
        if (typeof record.item !== 'string') continue
        const snapshotFormat = record.snapshot?.format
        formats.push({
          itemId: record.item as ItemId,
          deleted: record.metadata?.deleted === true,
          hasSnapshot: record.snapshot !== undefined,
          ...(typeof snapshotFormat === 'number' ? { snapshotFormat } : {}),
          hasCipher: typeof record.cipher === 'string' && record.cipher.length > 0,
        })
      }
      lastEvaluatedKey = response.LastEvaluatedKey
    } while (lastEvaluatedKey)

    return formats
  }

  private async executeBatchGetWithRetry(
    requestItems: BatchGetCommandInput['RequestItems'],
    maxRetries = 5,
  ): Promise<Record<string, Record<string, unknown>[]>> {
    let currentRequestItems = requestItems
    let attempt = 0
    let delayMs = 100
    const accumulatedResponses: Record<string, Record<string, unknown>[]> = {}

    while (true) {
      let response
      try {
        response = await this.client.send(new BatchGetCommand({
          RequestItems: currentRequestItems,
        }))
      } catch (error) {
        if (!isTransientDynamoError(error)) {
          throw error
        }

        attempt += 1
        if (attempt > maxRetries) {
          throw error
        }

        const jitter = Math.random() * 50
        await new Promise(resolve => setTimeout(resolve, delayMs + jitter))
        delayMs = Math.min(delayMs * 2, 5000)

        continue
      }

      if (response.Responses) {
        for (const [tableName, items] of Object.entries(response.Responses)) {
          if (!accumulatedResponses[tableName]) {
            accumulatedResponses[tableName] = []
          }
          accumulatedResponses[tableName].push(...items)
        }
      }

      const unprocessed = response.UnprocessedKeys
      if (!unprocessed || Object.keys(unprocessed).length === 0) {
        break
      }

      attempt += 1
      if (attempt > maxRetries) {
        throw new Error(`Failed to execute BatchGetCommand after ${maxRetries} attempts due to DynamoDB unprocessed keys.`)
      }

      const jitter = Math.random() * 50
      await new Promise(resolve => setTimeout(resolve, delayMs + jitter))
      delayMs = Math.min(delayMs * 2, 5000)

      currentRequestItems = unprocessed
    }

    return accumulatedResponses
  }

  async fetchByIds(
    { account, itemIds }: { account: string; itemIds: string[] },
  ): Promise<VaultItem[]> {
    if (!itemIds || itemIds.length === 0) {
      return []
    }

    const uniqueItemIds = Array.from(new Set(itemIds))
    const batches = chunk(uniqueItemIds, 100)
    const results: VaultItem[] = []

    const projectionExpression = ['#itemKey', ...DATA_ATTRIBUTES].join(',')
    const expressionAttributeNames = {
      '#itemKey': 'item',
      ...DATA_ATTRIBUTE_NAMES,
    }

    for (const batch of batches) {
      const requestItems: BatchGetCommandInput['RequestItems'] = {
        [this.tables.items]: {
          Keys: batch.map(itemId => ({
            account,
            item: itemId,
          })),
          ProjectionExpression: projectionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
        },
      }
      const responses = await this.executeBatchGetWithRetry(requestItems)
      const items = responses[this.tables.items] as VaultItem[] | undefined
      if (items) {
        results.push(...items)
      }
    }

    for (const record of results) {
      if (record.snapshot?.cipher) {
        if (
          Buffer.isBuffer(record.snapshot.cipher) ||
          record.snapshot.cipher instanceof Uint8Array
        ) {
          record.snapshot.cipher = Buffer.from(record.snapshot.cipher).toString(
            'base64',
          )
        }
      }
    }

    return results
  }

  private async executeBatchWriteWithRetry(
    requestItems: BatchWriteCommandInput['RequestItems'],
    maxRetries = 5,
  ): Promise<void> {
    let currentRequestItems = requestItems
    let attempt = 0
    let delayMs = 100

    while (true) {
      let response
      try {
        response = await this.client.send(new BatchWriteCommand({
          RequestItems: currentRequestItems,
        }))
      } catch (error) {
        if (!isTransientDynamoError(error)) {
          throw error
        }

        attempt += 1
        if (attempt > maxRetries) {
          throw error
        }

        const jitter = Math.random() * 50
        await new Promise(resolve => setTimeout(resolve, delayMs + jitter))
        delayMs = Math.min(delayMs * 2, 5000)

        continue
      }

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
      delayMs = Math.min(delayMs * 2, 5000)

      currentRequestItems = unprocessed
    }
  }

  async appendSyncMessage(input: {
    account: string
    itemId: ItemId
    entry: StoredSyncMessage
  }): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tables.syncMessages,
      Item: {
        syncId: `${input.account}#${input.itemId}`,
        cursor: input.entry.cursor,
        account: input.account,
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
          [this.tables.syncMessages]: batch.map(message => ({
            PutRequest: {
              Item: {
                syncId: `${input.account}#${message.itemId}`,
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

  async getSyncMessages(input: {
    account: string
    itemId: ItemId
    fromCursor?: number
    limit?: number
    pageToken?: PageToken
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; nextPageToken?: PageToken }> {
    const expectedSyncId = `${input.account}#${input.itemId}`
    const exclusiveStartKey = input.pageToken
      ? decodeItemPageToken(input.pageToken, expectedSyncId, input.fromCursor)
      : undefined
    // A continuation starts from the token, which already lies after fromCursor
    const fromCursor = exclusiveStartKey ? undefined : input.fromCursor
    const hasCursor = typeof fromCursor === 'number'

    const response = await this.client.send(new QueryCommand({
      TableName: this.tables.syncMessages,
      KeyConditionExpression: hasCursor
        ? 'syncId = :syncId AND #c > :fromCursor'
        : 'syncId = :syncId',
      ExpressionAttributeNames: hasCursor
        ? { '#c': 'cursor' }
        : undefined,
      ExpressionAttributeValues: {
        ':syncId': expectedSyncId,
        ...(hasCursor ? { ':fromCursor': fromCursor } : undefined),
      },
      Limit: input.limit ?? DEFAULT_SYNC_MESSAGE_LIMIT,
      ExclusiveStartKey: exclusiveStartKey,
    }))

    return {
      messages: (response.Items as StoredSyncMessage[]) || [],
      hasMore: !!response.LastEvaluatedKey,
      nextPageToken: response.LastEvaluatedKey ? encodePageToken(response.LastEvaluatedKey) : undefined,
    }
  }

  validatePageToken(input: {
    account: string
    itemId?: ItemId
    cursor?: number
    pageToken: PageToken
  }): void {
    if (input.itemId) {
      decodeItemPageToken(input.pageToken, `${input.account}#${input.itemId}`, input.cursor)
    } else {
      decodeGlobalPageToken(input.pageToken, input.account)
    }
  }

  async getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor?: number
    pageToken?: PageToken
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; nextPageToken?: PageToken; scannedThroughCursor: number }> {
    const messagesByItem = new Map<ItemId, StoredSyncMessage[]>()

    const exclusiveStartKey = input.pageToken
      ? decodeGlobalPageToken(input.pageToken, input.account)
      : undefined
    // A continuation starts from the token, which already lies after the cursor
    const cursor = exclusiveStartKey ? undefined : input.cursor
    const hasCursor = typeof cursor === 'number'

    const response = await this.client.send(new QueryCommand({
      TableName: this.tables.syncMessages,
      IndexName: 'AccountCursorIndex',
      KeyConditionExpression: hasCursor
        ? 'account = :account AND #c > :cursor'
        : 'account = :account',
      ExpressionAttributeNames: hasCursor
        ? { '#c': 'cursor' }
        : undefined,
      ExpressionAttributeValues: {
        ':account': input.account,
        ...(hasCursor ? { ':cursor': cursor } : undefined),
      },
      Limit: DEFAULT_SYNC_MESSAGE_LIMIT,
      ExclusiveStartKey: exclusiveStartKey,
    }))

    // Highest cursor examined by this page (before any caller-side filtering), so clients can
    // track the global scan position independently of per-item cursors.
    let scannedThroughCursor = exclusiveStartKey?.cursor ?? input.cursor ?? 0

    for (const item of (response.Items as (StoredSyncMessage & { syncId: string })[] || [])) {
      if (typeof item.cursor === 'number' && item.cursor > scannedThroughCursor) {
        scannedThroughCursor = item.cursor
      }
      const itemId = item.syncId.split('#')[1] as ItemId
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
      hasMore: !!response.LastEvaluatedKey,
      nextPageToken: response.LastEvaluatedKey ? encodePageToken(response.LastEvaluatedKey) : undefined,
      scannedThroughCursor,
    }
  }
}

// Page tokens wrap DynamoDB's LastEvaluatedKey. Clients can read and forge them, which only lets
// them page through their own account's messages, so the keys are validated but not signed.
const SyncMessageKeySchema = z.object({
  syncId: z.string().min(1),
  cursor: z.number().int().min(0),
}).strict()
type SyncMessageKey = z.infer<typeof SyncMessageKeySchema>

const GlobalSyncMessageKeySchema = z.object({
  account: z.string().min(1),
  cursor: z.number().int().min(0),
  syncId: z.string().min(1),
}).strict()
type GlobalSyncMessageKey = z.infer<typeof GlobalSyncMessageKeySchema>

function encodePageToken(key: Record<string, unknown>): PageToken {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

function decodeItemPageToken(token: PageToken, expectedSyncId: string, fromCursor?: number): SyncMessageKey {
  const key = decodePageToken(token, SyncMessageKeySchema)
  if (key.syncId !== expectedSyncId) {
    throw new InvalidPageTokenError(`Page token is for another item: expected ${expectedSyncId}`)
  }
  if (typeof fromCursor === 'number' && key.cursor < fromCursor) {
    throw new InvalidPageTokenError(`Page token cannot start before cursor ${fromCursor}`)
  }
  return key
}

function decodeGlobalPageToken(token: PageToken, account: string): GlobalSyncMessageKey {
  const key = decodePageToken(token, GlobalSyncMessageKeySchema)
  if (key.account !== account || !key.syncId.startsWith(`${account}#`)) {
    throw new InvalidPageTokenError(`Page token is for another account: expected ${account}`)
  }
  return key
}

function decodePageToken<T>(token: PageToken, schema: z.ZodType<T>): T {
  let key: unknown
  try {
    key = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidPageTokenError('Page token is malformed')
  }
  const parsed = schema.safeParse(key)
  if (!parsed.success) {
    throw new InvalidPageTokenError('Page token is malformed')
  }
  return parsed.data
}

export function getConnectionParams(options?: DynamoDBClientConfig): DynamoDBClientConfig {
  const customEndpoint = !!process.env.DYNAMODB_ENDPOINT
  // Against AWS, fail a stalled connection or socket quickly so the SDK retries it within the
  // Lambda's time limit. `requestTimeout` is how long the socket may go idle, not the whole request's
  // duration. A local DynamoDB can be slow under test load, and a retry after a write that did land
  // fails its condition, so it gets no timeouts.
  const endpointArgs: DynamoDBClientConfig = customEndpoint ? {
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: 'local',
  } : {
    requestHandler: {
      connectionTimeout: 1_000,
      requestTimeout: 3_000,
    },
  }
  return {
    apiVersion: '2012-08-10',
    region: 'ap-southeast-2',
    ...endpointArgs,
    ...options,
  }
}
