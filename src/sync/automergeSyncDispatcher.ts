import { getAccountId } from '../api/util'
import { pullSyncBatch, pushSyncBatch } from '../api/vault/syncClient'
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
import {
  getActiveRealtimeBusAccount,
  hasActiveRealtimeBus,
  postRealtimeBusEvent,
  setRealtimeBusLocalEditHandler,
} from './realtimeBus'
import { decryptSyncMessage, encryptSyncMessage } from './automergeSyncCrypto'
import { AutomergeSyncTaskQueue } from './automergeSyncTaskQueue'

const SHOULD_THROW_SYNC_ERRORS = (
  typeof window !== 'undefined'
  && !!(window as Window & { Cypress?: unknown }).Cypress
)

let activeAccount: string | null = null
let syncQueue = new AutomergeSyncTaskQueue()

async function pushLocalMessagesBatch(account: string, itemIds: string[]): Promise<void> {
  const pendingBatch: Array<{
    itemId: string
    encryptedMessage: {
      iv: string
      cipher: string
    }
    nextSyncState: Parameters<typeof commitAutomergeSyncState>[1]
  }> = []

  for (const itemId of itemIds) {
    const generated = await createAutomergeSyncMessage(itemId)
    if (!generated || !generated.message) {
      continue
    }

    const encryptedMessage = await encryptSyncMessage(generated.message)
    pendingBatch.push({
      itemId,
      encryptedMessage,
      nextSyncState: generated.nextSyncState,
    })
  }

  if (pendingBatch.length === 0) {
    return
  }

  await pushSyncBatch({
    account,
    messages: pendingBatch.map(entry => ({
      itemId: entry.itemId,
      encryptedMessage: entry.encryptedMessage,
    })),
  })

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

    let highestCursor = readAutomergeSyncCursor(itemResult.itemId)

    for (const message of itemResult.messages || []) {
      if (!message?.encryptedMessage?.iv || !message?.encryptedMessage?.cipher) {
        continue
      }

      const decrypted = await decryptSyncMessage(message.encryptedMessage)
      const changed = await receiveAutomergeSyncMessage(itemResult.itemId, decrypted)
      if (changed) {
        updatedItemIds.add(itemResult.itemId)
      }

      if (typeof message.cursor === 'number' && message.cursor > highestCursor) {
        highestCursor = message.cursor
      }
    }

    if (typeof itemResult.nextCursor === 'number' && itemResult.nextCursor > highestCursor) {
      highestCursor = itemResult.nextCursor
    }

    if (highestCursor > 0) {
      await writeAutomergeSyncCursor(itemResult.itemId, highestCursor)
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
  const wrapped = syncQueue.enqueue(async () => {
    useSyncStore.getState().setIsSyncing(true)

    try {
      return await operation()
    } finally {
      useSyncStore.getState().setIsSyncing(false)
    }
  })

  if (!SHOULD_THROW_SYNC_ERRORS) {
    void wrapped.catch(() => undefined)
  }

  return wrapped
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
    await pushLocalMessagesBatch(account, [itemId])
  })
}

export async function pullRemoteMessagesNow(itemIds?: string[]): Promise<string[]> {
  const normalizedIds = uniqueItemIds(itemIds)
  if (normalizedIds.length === 0) {
    return []
  }

  const result = await enqueueSyncOperation(() => withActiveAccount(async account => {
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
    await pushLocalMessagesBatch(account, normalizedIds)
    await pullRemoteMessagesBatch(account, normalizedIds)
  })
}

async function pushItemIdsNow(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) {
    return
  }

  await withActiveAccount(async account => {
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
  const normalizedIds = uniqueItemIds(itemIds)

  if (normalizedIds.length > 0) {
    if (hasActiveRealtimeBus()) {
      postLocalEditEvents(normalizedIds)
    }

    if (activeAccount) {
      void enqueueSyncOperation(() => pushItemIdsNow(normalizedIds))
    }

    if (!activeAccount && !hasActiveRealtimeBus() && SHOULD_THROW_SYNC_ERRORS) {
      throw new Error('Sync dispatcher is not active')
    }
    return
  }

  void enqueueSyncOperation(() => runFullSync())
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (activeAccount === account) {
    return
  }

  stopAutomergeSyncDispatcher()
  activeAccount = account
  syncQueue = new AutomergeSyncTaskQueue()

  setRealtimeBusLocalEditHandler(itemId => {
    void enqueueSyncOperation(() => pushItemNow(itemId))
  })

  void enqueueSyncOperation(() => runFullSync())
}

export function stopAutomergeSyncDispatcher(): void {
  setRealtimeBusLocalEditHandler(null)
  activeAccount = null
  syncQueue.reset()
  useSyncStore.getState().setIsSyncing(false)
}
