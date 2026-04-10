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

const DB_NAME = 'FlockBackgroundSyncDB'
const DB_VERSION = 1
const STORE_NAME = 'kv'

const PENDING_PUSH_BATCHES_KEY = 'pending_push_batches_v1'
const PENDING_PUSH_COMMITS_KEY = 'pending_push_commits_v1'

const memoryFallbackStore = new Map<string, unknown>()

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error || new Error('IndexedDB request failed'))
    }
  })
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve()
    }

    transaction.onerror = () => {
      reject(transaction.error || new Error('IndexedDB transaction failed'))
    }

    transaction.onabort = () => {
      reject(transaction.error || new Error('IndexedDB transaction was aborted'))
    }
  })
}

function openBackgroundSyncDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null)
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'))
    }
  }).catch(() => null)
}

async function readStoreValue<T>(key: string, fallback: T): Promise<T> {
  const database = await openBackgroundSyncDb()
  if (!database) {
    const memoryValue = memoryFallbackStore.get(key)
    return (memoryValue === undefined ? fallback : memoryValue) as T
  }

  try {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(key)
    const value = await requestToPromise(request)
    await transactionToPromise(transaction)
    return (value === undefined ? fallback : value) as T
  } finally {
    database.close()
  }
}

async function modifyStoreValue<T>(
  key: string,
  fallback: T,
  modifier: (current: T) => T,
): Promise<T> {
  const database = await openBackgroundSyncDb()
  if (!database) {
    const memoryValue = memoryFallbackStore.get(key)
    const current = (memoryValue === undefined ? fallback : memoryValue) as T
    const nextValue = modifier(current)
    memoryFallbackStore.set(key, nextValue)
    return nextValue
  }

  return new Promise<T>((resolve, reject) => {
    let nextValue = fallback

    const closeDatabase = () => {
      database.close()
    }

    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(key)

    request.onerror = () => {
      closeDatabase()
      reject(request.error || new Error('IndexedDB request failed'))
    }

    request.onsuccess = () => {
      const currentValue = (request.result === undefined ? fallback : request.result) as T

      try {
        nextValue = modifier(currentValue)
      } catch (error) {
        closeDatabase()
        reject(error)
        transaction.abort()
        return
      }

      const writeRequest = store.put(nextValue, key)
      writeRequest.onerror = () => {
        closeDatabase()
        reject(writeRequest.error || new Error('IndexedDB write failed'))
        transaction.abort()
      }
    }

    transaction.oncomplete = () => {
      closeDatabase()
      resolve(nextValue)
    }

    transaction.onerror = () => {
      closeDatabase()
      reject(transaction.error || new Error('IndexedDB transaction failed'))
    }

    transaction.onabort = () => {
      closeDatabase()
      reject(transaction.error || new Error('IndexedDB transaction was aborted'))
    }
  })
}

function createBatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  const raw = await readStoreValue<unknown[]>(PENDING_PUSH_BATCHES_KEY, [])
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .map(normalizeBatch)
    .filter((batch): batch is BackgroundSyncPushBatch => batch !== null)
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

  const batch: BackgroundSyncPushBatch = {
    id: createBatchId(),
    account: input.account,
    authToken: input.authToken,
    messages,
    createdAt: Date.now(),
  }

  let nextBatchId: string | null = null

  await modifyStoreValue<unknown[]>(PENDING_PUSH_BATCHES_KEY, [], current => {
    const existing = Array.isArray(current)
      ? current.map(normalizeBatch).filter((entry): entry is BackgroundSyncPushBatch => entry !== null)
      : []

    const nextSignature = getBatchSignature(batch)
    const duplicate = existing.find(existingBatch => getBatchSignature(existingBatch) === nextSignature)
    if (duplicate) {
      nextBatchId = duplicate.id
      return existing
    }

    existing.push(batch)
    nextBatchId = batch.id
    return existing
  })

  return nextBatchId
}

export async function removeBackgroundSyncPushBatches(batchIds: string[]): Promise<void> {
  const normalizedIds = new Set(
    (batchIds || []).filter(batchId => typeof batchId === 'string' && batchId.length > 0),
  )

  if (normalizedIds.size === 0) {
    return
  }

  await modifyStoreValue<unknown[]>(PENDING_PUSH_BATCHES_KEY, [], current => {
    const existing = Array.isArray(current)
      ? current.map(normalizeBatch).filter((entry): entry is BackgroundSyncPushBatch => entry !== null)
      : []

    return existing.filter(batch => !normalizedIds.has(batch.id))
  })
}

export async function appendBackgroundSyncPushCommits(commits: BackgroundSyncPushCommit[]): Promise<void> {
  const normalizedCommits = (commits || [])
    .map(normalizeCommit)
    .filter((commit): commit is BackgroundSyncPushCommit => commit !== null)

  if (normalizedCommits.length === 0) {
    return
  }

  await modifyStoreValue<unknown[]>(PENDING_PUSH_COMMITS_KEY, [], current => {
    const existingCommits = Array.isArray(current)
      ? current.map(normalizeCommit).filter((commit): commit is BackgroundSyncPushCommit => commit !== null)
      : []

    const byAccountAndItemId = new Map<string, BackgroundSyncPushCommit>()

    for (const commit of existingCommits) {
      byAccountAndItemId.set(`${commit.account}:${commit.itemId}`, commit)
    }

    for (const commit of normalizedCommits) {
      byAccountAndItemId.set(`${commit.account}:${commit.itemId}`, {
        ...commit,
        committedAt: Date.now(),
      })
    }

    return Array.from(byAccountAndItemId.values())
  })
}

export async function consumeBackgroundSyncPushCommits(account: string): Promise<BackgroundSyncPushCommit[]> {
  if (typeof account !== 'string' || account.length === 0) {
    return []
  }

  const matched: BackgroundSyncPushCommit[] = []

  await modifyStoreValue<unknown[]>(PENDING_PUSH_COMMITS_KEY, [], current => {
    const existingCommits = Array.isArray(current)
      ? current.map(normalizeCommit).filter((commit): commit is BackgroundSyncPushCommit => commit !== null)
      : []

    if (existingCommits.length === 0) {
      return existingCommits
    }

    const remaining: BackgroundSyncPushCommit[] = []

    for (const commit of existingCommits) {
      if (commit.account === account) {
        matched.push(commit)
      } else {
        remaining.push(commit)
      }
    }

    return remaining
  })

  if (matched.length === 0) {
    return []
  }

  return matched
}