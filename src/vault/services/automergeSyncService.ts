import type { ItemId } from 'src/shared/schemas/items'
import {
  type AutomergeSyncRepository,
  type StoredSyncMessage,
} from './automergeSyncRepository'

type SyncMessagePayload = {
  iv: string
  cipher: string
  version?: string
}

type PullSyncMessageInput = {
  account: string
  itemId: ItemId
  cursor?: number
}

type PullSyncBatchInput = {
  account: string
  cursors: Array<{
    itemId: ItemId
    cursor?: number
  }>
}

type PushSyncBatchInput = {
  account: string
  messages: Array<{
    itemId: ItemId
    encryptedMessage: SyncMessagePayload
  }>
}

type AutomergeSyncServiceDeps = {
  now?: () => number
  repository: AutomergeSyncRepository
}

function sortMessagesAscendingByCursor(messages: StoredSyncMessage[]): StoredSyncMessage[] {
  return messages.slice().sort((left, right) => left.cursor - right.cursor)
}

const SYNC_MESSAGE_PAGE_LIMIT = 200
const TIMESTAMP_MULTIPLIER = 10_000_000
const MAX_OFFSET = 9_999_000
const CUSTOM_EPOCH = 1760000000000 // 2026-01-01T00:00:00.000Z

export function createAutomergeSyncService({
  now = Date.now,
  repository,
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
        account: input.account,
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
  }> {
    const fromCursor = typeof input.cursor === 'number' ? input.cursor : 0
    const overlapCursor = Math.max(0, fromCursor - TIMESTAMP_MULTIPLIER)
    const { messages: storedMessages, hasMore } = await repository.getSyncMessages({
      account: input.account,
      itemId: input.itemId,
      fromCursor: overlapCursor,
      limit: SYNC_MESSAGE_PAGE_LIMIT,
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
    }>
  }> {
    const dedupedCursorsByItemId = new Map<ItemId, number>()
    for (const cursorInput of input.cursors) {
      const existing = dedupedCursorsByItemId.get(cursorInput.itemId) || 0
      const next = typeof cursorInput.cursor === 'number' ? cursorInput.cursor : 0
      dedupedCursorsByItemId.set(cursorInput.itemId, Math.max(existing, next))
    }

    const results = await Promise.all(
      Array
        .from(dedupedCursorsByItemId.entries())
        .map(([itemId, cursor]) => pullAutomergeSyncMessages({
          account: input.account,
          itemId,
          cursor,
        })),
    )

    return {
      success: true,
      results,
    }
  }

  async function pullAutomergeSyncGlobal(input: { account: string; cursor: number }): Promise<{
    success: true
    results: Array<{
      success: true
      itemId: ItemId
      nextCursor: number
      messages: StoredSyncMessage[]
      hasMore: boolean
    }>
  }> {
    const overlapCursor = Math.max(0, input.cursor - TIMESTAMP_MULTIPLIER)
    const { items, hasMore } = await repository.getGlobalSyncMessagesAfterCursor({
      account: input.account,
      cursor: overlapCursor,
    })

    const results = items.map((item, index) => {
      const messages = item.messages
      return {
        success: true as const,
        itemId: item.itemId,
        nextCursor: messages.length > 0 ? messages[messages.length - 1].cursor : input.cursor,
        messages,
        hasMore: index === items.length - 1 ? hasMore : false,
      }
    })

    return { success: true, results }
  }

  return {
    pushAutomergeSyncBatch,
    pullAutomergeSyncBatch,
    pullAutomergeSyncGlobal,
  }
}

// Removed module-level global singleton to support dynamic per-request instantiations
