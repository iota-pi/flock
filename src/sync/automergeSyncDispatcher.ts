import { getAccountId } from '../api/util'
import { ApiHttpError, getApiAuthToken, handleVaultError } from '../api/runtime'
import { pullSyncBatch, pushSyncBatch } from '../api/vault/syncClient'
import {
  commitAutomergeSyncState,
  createAutomergeSyncMessage,
  filterAutomergeLocallyChangedDocumentIds,
  initializeAutomergeDocStore,
  listAutomergeDocumentIds,
  readAutomergeSyncCursor,
  receiveAutomergeSyncMessage,
} from './automergeDocStore'
import { useSyncStore } from '../state/syncStore'
import {
  getActiveRealtimeBusAccount,
  hasActiveRealtimeBus,
  postRealtimeBusEvent,
  setRealtimeBusLocalEditHandler,
} from './realtimeBus'
import { decryptSyncMessage, encryptSyncMessage } from './automergeSyncCrypto'
import { AutomergeSyncTaskQueue } from './automergeSyncTaskQueue'
import {
  BACKGROUND_SYNC_PUSH_TAG,
  listBackgroundSyncPushBatches,
  consumeBackgroundSyncPushCommits,
  enqueueBackgroundSyncPushBatch,
  removeBackgroundSyncPushBatches,
} from './backgroundSyncPushQueue'

const SHOULD_THROW_SYNC_ERRORS = (
  typeof window !== 'undefined'
  && !!(window as Window & { Cypress?: unknown }).Cypress
)

let activeAccount: string | null = null
let syncQueue = new AutomergeSyncTaskQueue()
let lastSyncErrorReportAt = 0
let lastBackgroundSyncRegistrationAt = 0
let removeVisibilitySyncListener: (() => void) | null = null

const SYNC_ERROR_REPORT_THROTTLE_MS = 15_000
const BACKGROUND_SYNC_REGISTER_THROTTLE_MS = 10_000
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])

function normalizeSyncError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function reportSyncError(error: unknown): void {
  const normalized = normalizeSyncError(error)

  const now = Date.now()
  if (now - lastSyncErrorReportAt < SYNC_ERROR_REPORT_THROTTLE_MS) {
    console.error('[Sync] Background sync failed', normalized)
    return
  }

  lastSyncErrorReportAt = now
  handleVaultError(normalized, 'Background sync failed. Local changes will retry on the next sync event.')
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function isOfflineOrNetworkError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true
  }

  return error instanceof TypeError
}

function isRetryableSyncError(error: unknown): boolean {
  if (isOfflineOrNetworkError(error)) {
    return true
  }

  if (error instanceof ApiHttpError) {
    return RETRYABLE_HTTP_STATUS_CODES.has(error.status)
  }

  const message = normalizeSyncError(error).message.toLowerCase()
  return (
    message.includes('timeout')
    || message.includes('temporarily unavailable')
    || message.includes('service unavailable')
    || message.includes('gateway timeout')
  )
}

async function registerBackgroundSyncPush(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return
  }

  const now = Date.now()
  if (now - lastBackgroundSyncRegistrationAt < BACKGROUND_SYNC_REGISTER_THROTTLE_MS) {
    return
  }

  const registration = await navigator.serviceWorker.ready
  const syncRegistration = registration as ServiceWorkerRegistration & {
    sync?: {
      register: (tag: string) => Promise<void>
    }
  }

  if (!syncRegistration.sync?.register) {
    return
  }

  await syncRegistration.sync.register(BACKGROUND_SYNC_PUSH_TAG)
  lastBackgroundSyncRegistrationAt = now
}

async function flushBackgroundSyncPushCommits(account: string): Promise<void> {
  const commits = await consumeBackgroundSyncPushCommits(account)
  if (commits.length === 0) {
    return
  }

  await Promise.all(commits.map(async commit => {
    await commitAutomergeSyncState(commit.itemId, decodeBase64ToBytes(commit.nextSyncState))
  }))
}

async function flushQueuedBackgroundPushBatches(account: string): Promise<void> {
  const pendingBatches = await listBackgroundSyncPushBatches()
  if (pendingBatches.length === 0) {
    return
  }

  const accountBatches = pendingBatches.filter(batch => batch.account === account)
  if (accountBatches.length === 0) {
    return
  }

  const processedBatchIds: string[] = []

  for (const batch of accountBatches) {
    try {
      await pushSyncBatch({
        account: batch.account,
        messages: batch.messages.map(message => ({
          itemId: message.itemId,
          encryptedMessage: message.encryptedMessage,
        })),
      })

      processedBatchIds.push(batch.id)

      await Promise.all(batch.messages.map(async message => {
        await commitAutomergeSyncState(message.itemId, decodeBase64ToBytes(message.nextSyncState))
      }))
    } catch (error) {
      if (isRetryableSyncError(error)) {
        break
      }

      processedBatchIds.push(batch.id)
    }
  }

  if (processedBatchIds.length > 0) {
    await removeBackgroundSyncPushBatches(processedBatchIds)
  }
}

async function pushLocalMessagesBatch(account: string, itemIds: string[]): Promise<void> {
  const dirtyItemIds = filterAutomergeLocallyChangedDocumentIds(itemIds)
  if (dirtyItemIds.length === 0) {
    return
  }

  type PendingSyncEntry = {
    itemId: string
    encryptedMessage: {
      iv: string
      cipher: string
    }
    nextSyncState: Parameters<typeof commitAutomergeSyncState>[1]
    nextSyncStateEncoded: string
  }

  const pendingBatch = (await Promise.all(dirtyItemIds.map(async itemId => {
    const generated = await createAutomergeSyncMessage(itemId)
    if (!generated || !generated.message) {
      return null
    }

    const encryptedMessage = await encryptSyncMessage(generated.message)
    return {
      itemId,
      encryptedMessage,
      nextSyncState: generated.nextSyncState,
      nextSyncStateEncoded: encodeBytesToBase64(generated.nextSyncState),
    } satisfies PendingSyncEntry
  }))).filter((entry): entry is PendingSyncEntry => entry !== null)

  if (pendingBatch.length === 0) {
    return
  }

  try {
    await pushSyncBatch({
      account,
      messages: pendingBatch.map(entry => ({
        itemId: entry.itemId,
        encryptedMessage: entry.encryptedMessage,
      })),
    })
  } catch (error) {
    if (isRetryableSyncError(error)) {
      const authToken = getApiAuthToken()
      if (authToken) {
        await enqueueBackgroundSyncPushBatch({
          account,
          authToken,
          messages: pendingBatch.map(entry => ({
            itemId: entry.itemId,
            encryptedMessage: entry.encryptedMessage,
            nextSyncState: entry.nextSyncStateEncoded,
          })),
        })

        await registerBackgroundSyncPush().catch(() => undefined)
      }
    }

    throw error
  }

  await Promise.all(pendingBatch.map(entry => (
    commitAutomergeSyncState(entry.itemId, entry.nextSyncState)
  )))
}

async function pullRemoteMessagesBatch(account: string, itemIds: string[]): Promise<string[]> {
  const response = await pullSyncBatch({
    account,
    cursors: itemIds.map(itemId => ({
      itemId,
      cursor: readAutomergeSyncCursor(itemId),
    })),
  })

  const updatedItemIds = new Set<string>()

  for (const itemResult of response.results) {
    if (!itemResult || typeof itemResult.itemId !== 'string' || itemResult.itemId.length === 0) {
      continue
    }

    for (const message of itemResult.messages || []) {
      if (!message?.encryptedMessage?.iv || !message?.encryptedMessage?.cipher) {
        continue
      }

      const decrypted = await decryptSyncMessage(message.encryptedMessage)
      const received = await receiveAutomergeSyncMessage(
        itemResult.itemId,
        decrypted,
        typeof message.cursor === 'number' ? message.cursor : undefined,
      )

      if (received.changed) {
        updatedItemIds.add(itemResult.itemId)
      }
    }
  }

  return Array.from(updatedItemIds)
}

function uniqueItemIds(itemIds?: string[]): string[] {
  const source = Array.isArray(itemIds) && itemIds.length > 0
    ? itemIds
    : listAutomergeDocumentIds()

  const unique = new Set<string>()
  for (const itemId of source) {
    if (typeof itemId !== 'string' || itemId.length === 0) {
      continue
    }

    unique.add(itemId)
  }

  return Array.from(unique)
}

function enqueueSyncOperation<T>(operation: () => Promise<T>): Promise<T> {
  const wrapped = syncQueue.enqueue(
    async () => {
      useSyncStore.getState().setIsSyncing(true)

      try {
        return await operation()
      } finally {
        useSyncStore.getState().setIsSyncing(false)
      }
    },
    {
      shouldRetry: error => !SHOULD_THROW_SYNC_ERRORS && isRetryableSyncError(error),
      maxRetries: 5,
      initialRetryDelayMs: 400,
      maxRetryDelayMs: 20_000,
    },
  )

  if (!SHOULD_THROW_SYNC_ERRORS) {
    void wrapped.catch(error => {
      reportSyncError(error)
    })
  }

  return wrapped
}

function installVisibilitySyncFallback(): void {
  if (removeVisibilitySyncListener || typeof document === 'undefined') {
    return
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible' || !activeAccount) {
      return
    }

    void enqueueSyncOperation(() => withActiveAccount(async account => {
      await flushQueuedBackgroundPushBatches(account)
      await flushBackgroundSyncPushCommits(account)
    }))
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  removeVisibilitySyncListener = () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}

function uninstallVisibilitySyncFallback(): void {
  if (!removeVisibilitySyncListener) {
    return
  }

  removeVisibilitySyncListener()
  removeVisibilitySyncListener = null
}

async function withActiveAccount<T>(action: (account: string) => Promise<T>): Promise<T | undefined> {
  const account = activeAccount
  if (!account) {
    return undefined
  }

  await initializeAutomergeDocStore(account)
  return action(account)
}

async function pushItemNow(itemId: string): Promise<void> {
  await withActiveAccount(async account => {
    await flushQueuedBackgroundPushBatches(account)
    await flushBackgroundSyncPushCommits(account)
    await pushLocalMessagesBatch(account, [itemId])
  })
}

export async function pullRemoteMessagesNow(itemIds?: string[]): Promise<string[]> {
  const normalizedIds = uniqueItemIds(itemIds)
  if (normalizedIds.length === 0) {
    return []
  }

  const result = await enqueueSyncOperation(() => withActiveAccount(async account => {
    await flushQueuedBackgroundPushBatches(account)
    await flushBackgroundSyncPushCommits(account)
    return pullRemoteMessagesBatch(account, normalizedIds)
  }))

  return result || []
}

async function runFullSync(itemIds?: string[]): Promise<void> {
  const normalizedIds = uniqueItemIds(itemIds)
  if (normalizedIds.length === 0) {
    return
  }

  await withActiveAccount(async account => {
    await flushQueuedBackgroundPushBatches(account)
    await flushBackgroundSyncPushCommits(account)
    await pushLocalMessagesBatch(account, normalizedIds)
    await pullRemoteMessagesBatch(account, normalizedIds)
  })
}

async function pushItemIdsNow(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) {
    return
  }

  await withActiveAccount(async account => {
    await flushQueuedBackgroundPushBatches(account)
    await flushBackgroundSyncPushCommits(account)
    await pushLocalMessagesBatch(account, itemIds)
  })
}

function resolveAccountForRealtimeBus(): string | null {
  const busAccount = getActiveRealtimeBusAccount()
  if (busAccount) {
    return busAccount
  }

  try {
    return getAccountId()
  } catch {
    return null
  }
}

function postLocalEditEvents(itemIds: string[]): void {
  const account = resolveAccountForRealtimeBus()
  if (!account) {
    return
  }

  for (const itemId of itemIds) {
    postRealtimeBusEvent({
      type: 'LOCAL_EDIT',
      itemId,
    })
  }
}

export function requestAutomergeSync(itemIds?: string[]): void {
  const hasExplicitItemIds = Array.isArray(itemIds) && itemIds.length > 0
  const normalizedIds = uniqueItemIds(itemIds)

  if (hasExplicitItemIds && normalizedIds.length > 0) {
    const dirtyIds = filterAutomergeLocallyChangedDocumentIds(normalizedIds)
    if (dirtyIds.length === 0) {
      return
    }

    if (hasActiveRealtimeBus()) {
      postLocalEditEvents(dirtyIds)
    }

    if (activeAccount) {
      void enqueueSyncOperation(() => pushItemIdsNow(dirtyIds))
    }

    if (!activeAccount && !hasActiveRealtimeBus() && SHOULD_THROW_SYNC_ERRORS) {
      throw new Error('Sync dispatcher is not active')
    }
    return
  }

  void enqueueSyncOperation(() => runFullSync(normalizedIds))
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (activeAccount === account) {
    return
  }

  stopAutomergeSyncDispatcher()
  activeAccount = account
  syncQueue = new AutomergeSyncTaskQueue()
  installVisibilitySyncFallback()

  setRealtimeBusLocalEditHandler(itemId => {
    void enqueueSyncOperation(() => pushItemNow(itemId))
  })

  void enqueueSyncOperation(() => runFullSync())
}

export function stopAutomergeSyncDispatcher(): void {
  setRealtimeBusLocalEditHandler(null)
  activeAccount = null
  uninstallVisibilitySyncFallback()
  syncQueue.reset()
  useSyncStore.getState().setIsSyncing(false)
}
