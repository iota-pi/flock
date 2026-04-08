import { decryptBytesWithKey, encryptBytesWithKey } from '../api/vault/crypto'
import { getVaultKey } from '../api/vault'
import { syncDB } from '../api/db'
import { pullSyncMessages, pushSyncMessage } from '../api/vault/syncClient'
import {
  commitAutomergeSyncState,
  createAutomergeSyncMessage,
  initializeAutomergeDocStore,
  listAutomergeDocumentIds,
  readAutomergeSyncCursor,
  receiveAutomergeSyncMessage,
  writeAutomergeSyncCursor,
} from './automergeDocStore'
import { useSyncStore } from '../state/syncStore'

const FALLBACK_POLL_INTERVAL_MS = 10 * 60 * 1000
const MAX_PUSH_MESSAGES_PER_ITEM = 10
const SYNC_QUEUE_STORAGE_KEY = 'automerge-pending-sync-queue'
const SHOULD_THROW_SYNC_ERRORS = (
  typeof window !== 'undefined'
  && !!(window as Window & { Cypress?: unknown }).Cypress
)

let activeAccount: string | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null
let syncing = false
let isQueueLoaded = false
const pendingRequestedDocumentIds = new Set<string>()

function getSyncQueueStorageKey(account: string): string {
  return `${SYNC_QUEUE_STORAGE_KEY}_${account}`
}

async function persistPendingQueue(account: string): Promise<void> {
  await syncDB.setItem(getSyncQueueStorageKey(account), Array.from(pendingRequestedDocumentIds))
}

function scheduleImmediateSync(): void {
  queueMicrotask(() => {
    void runSyncCycle()
  })
}

async function pushLocalMessages(account: string, itemId: string): Promise<void> {
  for (let iteration = 0; iteration < MAX_PUSH_MESSAGES_PER_ITEM; iteration += 1) {
    const generated = createAutomergeSyncMessage(itemId)
    if (!generated || !generated.message) {
      return
    }

    const encryptedMessage = await encryptBytesWithKey(getVaultKey(), generated.message)
    await pushSyncMessage({
      account,
      itemId,
      encryptedMessage,
    })

    await commitAutomergeSyncState(itemId, generated.nextSyncState)
  }
}

async function pullRemoteMessages(account: string, itemId: string): Promise<void> {
  const cursor = readAutomergeSyncCursor(itemId)
  const response = await pullSyncMessages({
    account,
    itemId,
    cursor,
  })

  if (!Array.isArray(response.messages) || response.messages.length === 0) {
    if (typeof response.nextCursor === 'number' && response.nextCursor > cursor) {
      await writeAutomergeSyncCursor(itemId, response.nextCursor)
    }
    return
  }

  for (const message of response.messages) {
    if (!message?.encryptedMessage?.iv || !message?.encryptedMessage?.cipher) {
      continue
    }

    const decrypted = await decryptBytesWithKey(getVaultKey(), message.encryptedMessage)
    await receiveAutomergeSyncMessage(itemId, decrypted)

    if (typeof message.cursor === 'number' && message.cursor > 0) {
      await writeAutomergeSyncCursor(itemId, message.cursor)
    }
  }

}

async function runSyncCycle(): Promise<void> {
  if (syncing || !activeAccount || !isQueueLoaded) {
    return
  }

  const account = activeAccount

  syncing = true
  useSyncStore.getState().setIsSyncing(true)
  try {
    await initializeAutomergeDocStore(account)

    const targetIds = Array.from(pendingRequestedDocumentIds)

    if (targetIds.length === 0) {
      return
    }

    for (const itemId of targetIds) {
      try {
        await pushLocalMessages(account, itemId)
        await pullRemoteMessages(account, itemId)
        pendingRequestedDocumentIds.delete(itemId)
        await persistPendingQueue(account)
      } catch (error) {
        if (SHOULD_THROW_SYNC_ERRORS) {
          throw error
        }
      }
    }
  } catch (error) {
    // Sync is best-effort; failures are retried on future sync requests.
    if (SHOULD_THROW_SYNC_ERRORS) {
      throw error
    }
  } finally {
    useSyncStore.getState().setIsSyncing(false)
    syncing = false
  }
}

export function requestAutomergeSync(documentIds?: string[]): void {
  const targetDocumentIds = Array.isArray(documentIds)
    ? documentIds
    : listAutomergeDocumentIds()

  let changed = false

  for (const documentId of targetDocumentIds) {
    if (typeof documentId !== 'string' || documentId.length === 0) {
      continue
    }

    if (pendingRequestedDocumentIds.has(documentId)) {
      continue
    }

    pendingRequestedDocumentIds.add(documentId)
    changed = true
  }

  if (changed && activeAccount) {
    void persistPendingQueue(activeAccount)
  }

  scheduleImmediateSync()
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (activeAccount === account && intervalHandle) {
    return
  }

  stopAutomergeSyncDispatcher()
  activeAccount = account
  isQueueLoaded = false

  void syncDB.getItem<string[]>(getSyncQueueStorageKey(account)).then(savedQueue => {
    if (activeAccount !== account) {
      return
    }

    if (Array.isArray(savedQueue)) {
      for (const id of savedQueue) {
        if (typeof id === 'string' && id.length > 0) {
          pendingRequestedDocumentIds.add(id)
        }
      }
    }

    isQueueLoaded = true
    scheduleImmediateSync()
  }).catch(() => {
    if (activeAccount !== account) {
      return
    }

    isQueueLoaded = true
    scheduleImmediateSync()
  })

  intervalHandle = setInterval(() => {
    void runSyncCycle()
  }, FALLBACK_POLL_INTERVAL_MS)
}

export function stopAutomergeSyncDispatcher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }

  activeAccount = null
  isQueueLoaded = false
  pendingRequestedDocumentIds.clear()
  useSyncStore.getState().setIsSyncing(false)
}
