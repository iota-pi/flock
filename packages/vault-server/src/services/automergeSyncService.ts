import type { z } from 'zod'
import type { ItemId, DOC_BOUND_FORMAT, PageToken, SyncPollBatchSchema } from '@vault/shared'
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

type PullSyncGlobalInput = {
  account: string
  cursor: number
  pageToken?: PageToken
}

type PushSyncBatchInput = {
  account: string
  messages: Array<{
    itemId: ItemId
    encryptedMessage: SyncMessagePayload
  }>
}

export type PollSyncInput = z.infer<typeof SyncPollBatchSchema>

/** The driver methods the sync service uses */
export type AutomergeSyncRepository = Pick<
  VaultDriver,
  'pushSyncMessagesBatch' | 'getSyncMessages' | 'getGlobalSyncMessagesAfterCursor' | 'validatePageToken'
>

export interface PushSyncBatchResult {
  success: true
  results: Array<{ itemId: ItemId; cursor: number }>
}

/** One item's pulled messages. Installed clients read the `success: true` fields, so they stay. */
export interface ItemPullResult {
  success: true
  itemId: ItemId
  nextCursor: number
  messages: StoredSyncMessage[]
  hasMore: boolean
  nextPageToken?: PageToken
}

export interface PullSyncBatchResult {
  success: true
  results: ItemPullResult[]
}

export interface PullSyncGlobalResult {
  success: true
  results: ItemPullResult[]
  hasMore: boolean
  nextPageToken?: PageToken
  scannedThroughCursor: number
}

export interface PollSyncResult {
  success: true
  pushResults: PushSyncBatchResult['results']
  pullResults: ItemPullResult[]
  hasMore: boolean
  globalNextPageToken: PageToken | undefined
  globalHasMore: boolean
  globalScannedThroughCursor: number | undefined
}

function sortMessagesAscendingByCursor(messages: StoredSyncMessage[]): StoredSyncMessage[] {
  return messages.slice().sort((left, right) => left.cursor - right.cursor)
}

export const DEFAULT_PULL_BATCH_CONCURRENCY = 10

const TIMESTAMP_MULTIPLIER = 10_000_000
const MAX_OFFSET = 9_999_000
const CUSTOM_EPOCH = 1760000000000 // 2025-10-09T08:53:20.000Z. Never change it: cursors must keep increasing

export async function pushAutomergeSyncBatch(
  vault: AutomergeSyncRepository,
  input: PushSyncBatchInput,
): Promise<PushSyncBatchResult> {
  const timestamp = Date.now()
  const relativeTimestampMs = Math.max(0, timestamp - CUSTOM_EPOCH)
  const relativeTimestampSeconds = Math.floor(relativeTimestampMs / 1000)

  // Generate a random invocation offset to prevent collisions from concurrent writes
  const invocationOffset = Math.floor(Math.random() * MAX_OFFSET)
  const baseCursor = relativeTimestampSeconds * TIMESTAMP_MULTIPLIER + invocationOffset
  const messagesWithCursor = input.messages.map((message, index) => ({
    ...message,
    cursor: baseCursor + index,
  }))

  await vault.pushSyncMessagesBatch({
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

async function pullAutomergeSyncMessages(
  vault: AutomergeSyncRepository,
  input: PullSyncMessageInput,
): Promise<ItemPullResult> {
  const fromCursor = typeof input.cursor === 'number' ? input.cursor : 0
  // The page size is the driver's to choose
  const { messages: storedMessages, hasMore, nextPageToken } = await vault.getSyncMessages({
    account: input.account,
    itemId: input.itemId,
    fromCursor,
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

export async function pullAutomergeSyncBatch(
  vault: AutomergeSyncRepository,
  input: PullSyncBatchInput,
): Promise<PullSyncBatchResult> {
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

  const concurrency = resolveConcurrency(input.concurrency, DEFAULT_PULL_BATCH_CONCURRENCY)
  const entries = Array.from(dedupedCursorsByItemId.entries())

  const results = await mapWithConcurrency(
    entries,
    concurrency,
    ([itemId, { cursor, pageToken }]) => pullAutomergeSyncMessages(vault, {
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

export async function pullAutomergeSyncGlobal(
  vault: AutomergeSyncRepository,
  input: PullSyncGlobalInput,
): Promise<PullSyncGlobalResult> {
  const { items, hasMore, nextPageToken, scannedThroughCursor } = await vault.getGlobalSyncMessagesAfterCursor({
    account: input.account,
    cursor: input.cursor,
    pageToken: input.pageToken,
  })

  const results = items.map((item): ItemPullResult => {
    const messages = item.messages
    return {
      success: true,
      itemId: item.itemId,
      nextCursor: messages.length > 0 ? messages[messages.length - 1].cursor : input.cursor,
      messages,
      hasMore: false,
    }
  })

  return { success: true, results, hasMore, nextPageToken, scannedThroughCursor }
}

/**
 * Pushes the client's messages, then pulls the items it is catching up on (`pullCursors`) and the
 * account-wide changes after `clientLatestCursor` in parallel. Throws `InvalidPageTokenError`
 * before storing anything if a page token is bad, or the client would push its messages again.
 */
export async function pollSync(
  vault: AutomergeSyncRepository,
  input: PollSyncInput,
): Promise<PollSyncResult> {
  if (input.globalPageToken) {
    vault.validatePageToken({ account: input.account, pageToken: input.globalPageToken })
  }
  for (const pullCursor of input.pullCursors) {
    if (pullCursor.pageToken) {
      vault.validatePageToken({
        account: input.account,
        itemId: pullCursor.itemId,
        cursor: pullCursor.cursor ?? 0,
        pageToken: pullCursor.pageToken,
      })
    }
  }

  const pushResults = input.pushMessages.length > 0
    ? (await pushAutomergeSyncBatch(vault, { account: input.account, messages: input.pushMessages })).results
    : []

  const shouldPullBatch = input.pullCursors.length > 0
  const shouldPullGlobal = typeof input.clientLatestCursor === 'number' || !!input.globalPageToken
  const [batchPullResult, globalPullResult] = await Promise.all([
    shouldPullBatch
      ? pullAutomergeSyncBatch(vault, { account: input.account, cursors: input.pullCursors })
      : null,
    shouldPullGlobal
      ? pullAutomergeSyncGlobal(vault, {
        account: input.account,
        cursor: input.clientLatestCursor ?? 0,
        pageToken: input.globalPageToken,
      })
      : null,
  ])

  // Items being pulled on their own are left out of the global results, so that a lagging item's
  // cursor doesn't jump past messages it hasn't caught up on yet
  const pullCursorItemIds = new Set(input.pullCursors.map(c => c.itemId))
  const globalResults = (globalPullResult?.results ?? []).filter(r => !pullCursorItemIds.has(r.itemId))
  const pullResults = [...(batchPullResult?.results ?? []), ...globalResults]
  const globalHasMore = globalPullResult?.hasMore ?? false

  return {
    success: true,
    pushResults,
    pullResults,
    hasMore: globalHasMore || pullResults.some(r => r.hasMore),
    globalNextPageToken: globalPullResult?.nextPageToken,
    globalHasMore,
    globalScannedThroughCursor: globalPullResult?.scannedThroughCursor,
  }
}
