import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export const BACKGROUND_SYNC_PUSH_TAG = 'flock-sync-push'

export type BackgroundSyncPushMessage = {
  itemId: string
  encryptedMessage: {
    iv: string
    cipher: string
  }
  nextSyncState: string
}

export type BackgroundSyncPushBatch = {
  id: string
  account: string
  authToken: string
  messages: BackgroundSyncPushMessage[]
  createdAt: number
}

export type BackgroundSyncPushCommit = {
  account: string
  itemId: string
  nextSyncState: string
  committedAt: number
}

type BackgroundSyncPushCommitRecord = BackgroundSyncPushCommit & {
  key: string
}

type BackgroundSyncPushQueueSchema = DBSchema & {
  kv: {
    key: string
    value: unknown
  }
  pendingPushBatches: {
    key: string
    value: BackgroundSyncPushBatch
    indexes: {
      'by-account': string
      'by-created-at': number
    }
  }
  pendingPushCommits: {
    key: string
    value: BackgroundSyncPushCommitRecord
    indexes: {
      'by-account': string
      'by-committed-at': number
    }
  }
}

export class BackgroundSyncQueueInitializationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'BackgroundSyncQueueInitializationError'

    if (options && 'cause' in options) {
      ; (this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

const DB_NAME = 'FlockBackgroundSyncDB'
const DB_VERSION = 2
const LEGACY_STORE_NAME = 'kv'
const BATCH_STORE_NAME = 'pendingPushBatches'
const COMMIT_STORE_NAME = 'pendingPushCommits'

const BATCH_ACCOUNT_INDEX = 'by-account'
const BATCH_CREATED_AT_INDEX = 'by-created-at'
const COMMIT_ACCOUNT_INDEX = 'by-account'
const COMMIT_COMMITTED_AT_INDEX = 'by-committed-at'

const LEGACY_PENDING_PUSH_BATCHES_KEY = 'pending_push_batches_v1'
const LEGACY_PENDING_PUSH_COMMITS_KEY = 'pending_push_commits_v1'

let dbPromise: Promise<IDBPDatabase<BackgroundSyncPushQueueSchema>> | null = null
let initializationError: BackgroundSyncQueueInitializationError | null = null
let hasMigratedLegacyQueueState = false
let legacyMigrationPromise: Promise<void> | null = null

function createInitializationError(cause?: unknown): BackgroundSyncQueueInitializationError {
  return new BackgroundSyncQueueInitializationError(
    'Background sync queue persistence is unavailable (IndexedDB could not be initialized).',
    { cause },
  )
}

async function getBackgroundSyncQueueDb(): Promise<IDBPDatabase<BackgroundSyncPushQueueSchema>> {
  if (initializationError) {
    throw initializationError
  }

  if (typeof indexedDB === 'undefined') {
    initializationError = createInitializationError(new Error('IndexedDB is not available in this environment'))
    throw initializationError
  }

  if (!dbPromise) {
    dbPromise = openDB<BackgroundSyncPushQueueSchema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(BATCH_STORE_NAME)) {
          const batches = database.createObjectStore(BATCH_STORE_NAME, {
            keyPath: 'id',
          })
          batches.createIndex(BATCH_ACCOUNT_INDEX, 'account')
          batches.createIndex(BATCH_CREATED_AT_INDEX, 'createdAt')
        }

        if (!database.objectStoreNames.contains(COMMIT_STORE_NAME)) {
          const commits = database.createObjectStore(COMMIT_STORE_NAME, {
            keyPath: 'key',
          })
          commits.createIndex(COMMIT_ACCOUNT_INDEX, 'account')
          commits.createIndex(COMMIT_COMMITTED_AT_INDEX, 'committedAt')
        }

        if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
          database.createObjectStore(LEGACY_STORE_NAME)
        }
      },
    }).catch(error => {
      initializationError = createInitializationError(error)
      dbPromise = null
      throw initializationError
    })
  }

  const database = await dbPromise
  await ensureLegacyQueueStateMigrated(database)
  return database
}

export async function initializeBackgroundSyncPushQueue(): Promise<void> {
  await getBackgroundSyncQueueDb()
}

function normalizeMessage(candidate: unknown): BackgroundSyncPushMessage | null {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const value = candidate as Partial<BackgroundSyncPushMessage>
  if (typeof value.itemId !== 'string' || value.itemId.length === 0) {
    return null
  }

  if (typeof value.nextSyncState !== 'string' || value.nextSyncState.length === 0) {
    return null
  }

  const encrypted = value.encryptedMessage
  if (!encrypted || typeof encrypted !== 'object') {
    return null
  }

  if (typeof encrypted.iv !== 'string' || typeof encrypted.cipher !== 'string') {
    return null
  }

  return {
    itemId: value.itemId,
    nextSyncState: value.nextSyncState,
    encryptedMessage: {
      iv: encrypted.iv,
      cipher: encrypted.cipher,
    },
  }
}

function normalizeBatch(candidate: unknown): BackgroundSyncPushBatch | null {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const value = candidate as Partial<BackgroundSyncPushBatch>
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return null
  }

  if (typeof value.account !== 'string' || value.account.length === 0) {
    return null
  }

  if (typeof value.authToken !== 'string' || value.authToken.length === 0) {
    return null
  }

  const normalizedMessages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter((message): message is BackgroundSyncPushMessage => message !== null)
    : []

  if (normalizedMessages.length === 0) {
    return null
  }

  return {
    id: value.id,
    account: value.account,
    authToken: value.authToken,
    messages: normalizedMessages,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
  }
}

function normalizeCommit(candidate: unknown): BackgroundSyncPushCommit | null {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const value = candidate as Partial<BackgroundSyncPushCommit>
  if (typeof value.account !== 'string' || value.account.length === 0) {
    return null
  }

  if (typeof value.itemId !== 'string' || value.itemId.length === 0) {
    return null
  }

  if (typeof value.nextSyncState !== 'string' || value.nextSyncState.length === 0) {
    return null
  }

  return {
    account: value.account,
    itemId: value.itemId,
    nextSyncState: value.nextSyncState,
    committedAt: typeof value.committedAt === 'number' ? value.committedAt : Date.now(),
  }
}

function normalizeCommitRecord(candidate: unknown): BackgroundSyncPushCommitRecord | null {
  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const value = candidate as Partial<BackgroundSyncPushCommitRecord>
  if (typeof value.key !== 'string' || value.key.length === 0) {
    return null
  }

  const commit = normalizeCommit(value)
  if (!commit) {
    return null
  }

  return {
    key: value.key,
    ...commit,
  }
}

function createCommitKey(account: string, itemId: string): string {
  return `${account}:${itemId}`
}

function toCommitRecord(commit: BackgroundSyncPushCommit): BackgroundSyncPushCommitRecord {
  return {
    key: createCommitKey(commit.account, commit.itemId),
    ...commit,
  }
}

function normalizeLegacyBatches(value: unknown): BackgroundSyncPushBatch[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(normalizeBatch)
    .filter((batch): batch is BackgroundSyncPushBatch => batch !== null)
}

function normalizeLegacyCommits(value: unknown): BackgroundSyncPushCommit[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map(normalizeCommit)
    .filter((commit): commit is BackgroundSyncPushCommit => commit !== null)
}

async function migrateLegacyQueueState(database: IDBPDatabase<BackgroundSyncPushQueueSchema>): Promise<void> {
  if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
    return
  }

  const legacyBatches = normalizeLegacyBatches(
    await database.get(LEGACY_STORE_NAME, LEGACY_PENDING_PUSH_BATCHES_KEY),
  )
  const legacyCommits = normalizeLegacyCommits(
    await database.get(LEGACY_STORE_NAME, LEGACY_PENDING_PUSH_COMMITS_KEY),
  )

  if (legacyBatches.length === 0 && legacyCommits.length === 0) {
    return
  }

  const transaction = database.transaction(
    [BATCH_STORE_NAME, COMMIT_STORE_NAME, LEGACY_STORE_NAME],
    'readwrite',
  )

  for (const batch of legacyBatches) {
    await transaction.objectStore(BATCH_STORE_NAME).put(batch)
  }

  for (const commit of legacyCommits) {
    await transaction.objectStore(COMMIT_STORE_NAME).put(toCommitRecord(commit))
  }

  await transaction.objectStore(LEGACY_STORE_NAME).delete(LEGACY_PENDING_PUSH_BATCHES_KEY)
  await transaction.objectStore(LEGACY_STORE_NAME).delete(LEGACY_PENDING_PUSH_COMMITS_KEY)
  await transaction.done
}

async function ensureLegacyQueueStateMigrated(database: IDBPDatabase<BackgroundSyncPushQueueSchema>): Promise<void> {
  if (hasMigratedLegacyQueueState) {
    return
  }

  if (!legacyMigrationPromise) {
    legacyMigrationPromise = migrateLegacyQueueState(database)
      .then(() => {
        hasMigratedLegacyQueueState = true
      })
      .catch(error => {
        legacyMigrationPromise = null
        throw createInitializationError(error)
      })
  }

  await legacyMigrationPromise
}

function getBatchSignature(batch: {
  account: string
  messages: BackgroundSyncPushMessage[]
}): string {
  const sortedMessages = [...batch.messages].sort((left, right) => {
    if (left.itemId === right.itemId) {
      return left.nextSyncState.localeCompare(right.nextSyncState)
    }

    return left.itemId.localeCompare(right.itemId)
  })

  const messageSignature = sortedMessages
    .map(message => `${message.itemId}:${message.nextSyncState}:${message.encryptedMessage.iv}:${message.encryptedMessage.cipher}`)
    .join('|')

  return `${batch.account}::${messageSignature}`
}

export async function listBackgroundSyncPushBatches(): Promise<BackgroundSyncPushBatch[]> {
  const database = await getBackgroundSyncQueueDb()
  const raw = await database.getAllFromIndex(BATCH_STORE_NAME, BATCH_CREATED_AT_INDEX)

  const batches = raw
    .map(normalizeBatch)
    .filter((batch): batch is BackgroundSyncPushBatch => batch !== null)

  return batches.sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id)
    }

    return left.createdAt - right.createdAt
  })
}

export async function enqueueBackgroundSyncPushBatch(input: {
  account: string
  authToken: string
  messages: BackgroundSyncPushMessage[]
}): Promise<string | null> {
  if (!input || typeof input.account !== 'string' || input.account.length === 0) {
    return null
  }

  if (typeof input.authToken !== 'string' || input.authToken.length === 0) {
    return null
  }

  const messages = Array.isArray(input.messages)
    ? input.messages.map(normalizeMessage).filter((message): message is BackgroundSyncPushMessage => message !== null)
    : []

  if (messages.length === 0) {
    return null
  }

  const signature = getBatchSignature({ account: input.account, messages })

  const batch: BackgroundSyncPushBatch = {
    id: signature,
    account: input.account,
    authToken: input.authToken,
    messages,
    createdAt: Date.now(),
  }

  const database = await getBackgroundSyncQueueDb()
  const transaction = database.transaction(BATCH_STORE_NAME, 'readwrite')

  const existing = await transaction.store.get(signature)
  if (existing) {
    await transaction.done
    return existing.id
  }

  await transaction.store.put(batch)
  await transaction.done
  return batch.id
}

export async function removeBackgroundSyncPushBatches(batchIds: string[]): Promise<void> {
  const normalizedIds = new Set(
    (batchIds || []).filter(batchId => typeof batchId === 'string' && batchId.length > 0),
  )

  if (normalizedIds.size === 0) {
    return
  }

  const database = await getBackgroundSyncQueueDb()
  const transaction = database.transaction(BATCH_STORE_NAME, 'readwrite')

  for (const batchId of normalizedIds) {
    await transaction.store.delete(batchId)
  }

  await transaction.done
}

export async function appendBackgroundSyncPushCommits(commits: BackgroundSyncPushCommit[]): Promise<void> {
  const normalizedCommits = (commits || [])
    .map(normalizeCommit)
    .filter((commit): commit is BackgroundSyncPushCommit => commit !== null)

  if (normalizedCommits.length === 0) {
    return
  }

  const database = await getBackgroundSyncQueueDb()
  const transaction = database.transaction(COMMIT_STORE_NAME, 'readwrite')

  for (const commit of normalizedCommits) {
    await transaction.store.put({
      key: createCommitKey(commit.account, commit.itemId),
      ...commit,
      committedAt: Date.now(),
    })
  }

  await transaction.done
}

export async function consumeBackgroundSyncPushCommits(account: string): Promise<BackgroundSyncPushCommit[]> {
  if (typeof account !== 'string' || account.length === 0) {
    return []
  }

  const database = await getBackgroundSyncQueueDb()
  const transaction = database.transaction(COMMIT_STORE_NAME, 'readwrite')
  const accountIndex = transaction.store.index(COMMIT_ACCOUNT_INDEX)

  const matchedRecords = (await accountIndex.getAll(account))
    .map(normalizeCommitRecord)
    .filter((commit): commit is BackgroundSyncPushCommitRecord => commit !== null)

  if (matchedRecords.length === 0) {
    await transaction.done
    return []
  }

  for (const commit of matchedRecords) {
    await transaction.store.delete(commit.key)
  }

  await transaction.done

  const commits = matchedRecords.map(({ key: _key, ...commit }) => commit)
  return commits.sort((left, right) => {
    if (left.committedAt === right.committedAt) {
      return left.itemId.localeCompare(right.itemId)
    }

    return left.committedAt - right.committedAt
  })
}
