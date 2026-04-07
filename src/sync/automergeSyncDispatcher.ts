import { emitDomainEvent } from '../events/domainEvents'
import { decryptBytesWithKey, encryptBytesWithKey } from '../api/vault/crypto'
import { getVaultKey } from '../api/vault'
import { pullSyncMessages, pushSyncMessage } from '../api/vault/syncClient'
import {
  commitAutomergeSyncState,
  createAutomergeSyncMessage,
  initializeAutomergeDocStore,
  listAutomergeItemIds,
  readAutomergeSyncCursor,
  receiveAutomergeSyncMessage,
  writeAutomergeSyncCursor,
} from './automergeDocStore'

const FALLBACK_POLL_INTERVAL_MS = 10 * 60 * 1000
const MAX_PUSH_MESSAGES_PER_ITEM = 10

let activeAccount: string | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null
let syncing = false
const pendingItemIds = new Set<string>()

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

  let changed = false
  for (const message of response.messages) {
    if (!message?.encryptedMessage?.iv || !message?.encryptedMessage?.cipher) {
      continue
    }

    const decrypted = await decryptBytesWithKey(getVaultKey(), message.encryptedMessage)
    const received = await receiveAutomergeSyncMessage(itemId, decrypted)
    changed = changed || received

    if (typeof message.cursor === 'number' && message.cursor > 0) {
      await writeAutomergeSyncCursor(itemId, message.cursor)
    }
  }

  if (changed) {
    emitDomainEvent({
      type: 'data:updated',
      domain: 'items',
      reason: 'automerge:sync',
    })
  }
}

async function runSyncCycle(): Promise<void> {
  if (syncing || !activeAccount) {
    return
  }

  syncing = true
  emitDomainEvent({ type: 'sync:processing-changed', isSyncing: true })
  try {
    await initializeAutomergeDocStore(activeAccount)

    const targetIds = pendingItemIds.size > 0
      ? Array.from(pendingItemIds)
      : listAutomergeItemIds()

    pendingItemIds.clear()

    for (const itemId of targetIds) {
      await pushLocalMessages(activeAccount, itemId)
      await pullRemoteMessages(activeAccount, itemId)
    }
  } finally {
    emitDomainEvent({ type: 'sync:processing-changed', isSyncing: false })
    syncing = false
  }
}

export function requestAutomergeSync(itemIds?: string[]): void {
  if (Array.isArray(itemIds)) {
    for (const itemId of itemIds) {
      if (itemId) {
        pendingItemIds.add(itemId)
      }
    }
  }

  scheduleImmediateSync()
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (activeAccount === account && intervalHandle) {
    return
  }

  stopAutomergeSyncDispatcher()
  activeAccount = account

  intervalHandle = setInterval(() => {
    void runSyncCycle()
  }, FALLBACK_POLL_INTERVAL_MS)

  scheduleImmediateSync()
}

export function stopAutomergeSyncDispatcher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }

  activeAccount = null
  pendingItemIds.clear()
}
