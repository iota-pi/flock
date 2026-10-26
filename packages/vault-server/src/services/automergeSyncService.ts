import type { ItemId, DOC_BOUND_FORMAT, PageToken } from '@vault/shared'
import type { StoredSyncMessage, VaultDriver } from '../drivers/vaultDriver'
import { mapWithConcurrency, resolveConcurrency } from '@vault/shared'

type SyncMessagePayload = {
  iv: string
  cipher: string
  kver?: string
  format?: typeof DOC_BOUND_FORMAT
  version?: string
}

type PullSyncMessageInput = {
  account: string
  itemId: ItemId
  cursor?: number
  pageToken?: PageToken
}

type PullSyncBatchInput = {
  account: string
  cursors: Array<{
    itemId: ItemId
    cursor?: number
    pageToken?: PageToken
  }>
  concurrency?: number
}

type PushSyncBatchInput = {
  account: string
  messages: Array<{
    itemId: ItemId
    encryptedMessage: SyncMessagePayload
  }>
}

/** The driver methods the sync service uses */
export type AutomergeSyncRepository = Pick<
  VaultDriver,
  'pushSyncMessagesBatch' | 'getSyncMessages' | 'getGlobalSyncMessagesAfterCursor'
>

type AutomergeSyncServiceDeps = {
  now?: () => number
  repository: AutomergeSyncRepository
  pullConcurrency?: number
}

function sortMessagesAscendingByCursor(messages: StoredSyncMessage[]): StoredSyncMessage[] {
  return messages.slice().sort((left, right) => left.cursor - right.cursor)
}

export const DEFAULT_PULL_BATCH_CONCURRENCY = 10

const SYNC_MESSAGE_PAGE_LIMIT = 200
const TIMESTAMP_MULTIPLIER = 10_000_000
const MAX_OFFSET = 9_999_000
const CUSTOM_EPOCH = 1760000000000 // 2025-10-09T08:53:20.000Z. Never change it: cursors must keep increasing

export function createAutomergeSyncService({
  now = Date.now,
  repository,
  pullConcurrency = DEFAULT_PULL_BATCH_CONCURRENCY,
}: AutomergeSyncServiceDeps) {
  async function pushAutomergeSyncBatch(input: PushSyncBatchInput): Promise<{ success: true; results: Array<{ itemId: ItemId; cursor: number }> }> {
    const timestamp = now()
    const relativeTimestampMs = Math.max(0, timestamp - CUSTOM_EPOCH)
    const relativeTimestampSeconds = Math.floor(relativeTimestampMs / 1000)

    // Generate a random invocation offset to prevent collisions from concurrent writes
    const invocationOffset = Math.floor(Math.random() * MAX_OFFSET)
    const baseCursor = relativeTimestampSeconds * TIMESTAMP_MULTIPLIER + invocationOffset
    const messagesWithCursor = input.messages.map((message, index) => ({
      ...message,
      cursor: baseCursor + index,
    }))

    await repository.pushSyncMessagesBatch({
      account: input.account,
      messages: messagesWithCursor.map(message => ({
        itemId: message.itemId,
        entry: {
          cursor: message.cursor,
          encryptedMessage: message.encryptedMessage,
          createdAt: timestamp,
        },
        lastModified: timestamp,
      })),
    })

    const results = messagesWithCursor.map(message => ({
      itemId: message.itemId,
      cursor: message.cursor,
    }))

    return {
      success: true,
      results,
    }
  }

  async function pullAutomergeSyncMessages(input: PullSyncMessageInput): Promise<{
    success: true
    itemId: ItemId
    nextCursor: number
    messages: StoredSyncMessage[]
    hasMore: boolean
    nextPageToken?: PageToken
  }> {
    const fromCursor = typeof input.cursor === 'number' ? input.cursor : 0
    const { messages: storedMessages, hasMore, nextPageToken } = await repository.getSyncMessages({
      account: input.account,
      itemId: input.itemId,
      fromCursor,
      limit: SYNC_MESSAGE_PAGE_LIMIT,
      pageToken: input.pageToken,
    })
    const messages = sortMessagesAscendingByCursor(storedMessages)
    const nextCursor = messages.length > 0
      ? messages[messages.length - 1].cursor
      : fromCursor

    return {
      success: true,
      itemId: input.itemId,
      nextCursor,
      messages,
      hasMore,
      nextPageToken,
    }
  }

  async function pullAutomergeSyncBatch(input: PullSyncBatchInput): Promise<{
    success: true
    results: Array<{
      success: true
      itemId: ItemId
      nextCursor: number
      messages: StoredSyncMessage[]
      hasMore: boolean
      nextPageToken?: PageToken
    }>
  }> {
    const dedupedCursorsByItemId = new Map<ItemId, { cursor: number; pageToken?: PageToken }>()
    for (const cursorInput of input.cursors) {
      const nextCursor = typeof cursorInput.cursor === 'number' ? cursorInput.cursor : 0
      const existing = dedupedCursorsByItemId.get(cursorInput.itemId)
      if (!existing || nextCursor >= existing.cursor) {
        dedupedCursorsByItemId.set(cursorInput.itemId, {
          cursor: nextCursor,
          pageToken: cursorInput.pageToken,
        })
      }
    }

    const concurrency = resolveConcurrency(input.concurrency ?? pullConcurrency, DEFAULT_PULL_BATCH_CONCURRENCY)
    const entries = Array.from(dedupedCursorsByItemId.entries())

    const results = await mapWithConcurrency(
      entries,
      concurrency,
      ([itemId, { cursor, pageToken }]) => pullAutomergeSyncMessages({
        account: input.account,
        itemId,
        cursor,
        pageToken,
      }),
    )

    return {
      success: true,
      results,
    }
  }

  async function pullAutomergeSyncGlobal(input: {
    account: string
    cursor: number
    pageToken?: PageToken
  }): Promise<{
    success: true
    results: Array<{
      success: true
      itemId: ItemId
      nextCursor: number
      messages: StoredSyncMessage[]
      hasMore: boolean
    }>
    hasMore: boolean
    nextPageToken?: PageToken
    scannedThroughCursor: number
  }> {
    const { items, hasMore, nextPageToken, scannedThroughCursor } = await repository.getGlobalSyncMessagesAfterCursor({
      account: input.account,
      cursor: input.cursor,
      pageToken: input.pageToken,
    })

    const results = items.map(item => {
      const messages = item.messages
      return {
        success: true as const,
        itemId: item.itemId,
        nextCursor: messages.length > 0 ? messages[messages.length - 1].cursor : input.cursor,
        messages,
        hasMore: false,
      }
    })

    return { success: true, results, hasMore, nextPageToken, scannedThroughCursor }
  }

  return {
    pushAutomergeSyncBatch,
    pullAutomergeSyncBatch,
    pullAutomergeSyncGlobal,
  }
}

