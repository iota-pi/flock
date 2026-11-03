import type { z } from 'zod'
import type { ItemId, PageToken, SyncPollBatchSchema } from '@vault/shared'
import type { PushSyncMessagesInput, StoredSyncMessage, VaultDriver } from '../drivers/vaultDriver'
import { mapWithConcurrency } from '@vault/shared'

export type PollSyncInput = z.infer<typeof SyncPollBatchSchema>

type PushSyncBatchInput = Pick<PollSyncInput, 'account'> & { messages: PollSyncInput['pushMessages'] }
type PullSyncBatchInput = Pick<PollSyncInput, 'account'> & {
  cursors: PollSyncInput['pullCursors']
  throughCursor?: number
}
type PullSyncMessageInput = Pick<PollSyncInput, 'account'> & {
  itemId: ItemId
  cursor: number
  throughCursor?: number
  pageToken?: PageToken
}

type PullSyncGlobalInput = Pick<PollSyncInput, 'account'> & {
  cursor: number
  throughCursor?: number
  pageToken?: PageToken
}

export interface PollSyncOptions {
  /** How old a message's cursor must be before a pull returns it (`SYNC_SETTLE_MS` by default) */
  settleMs?: number
  now?: number
}

/** The driver methods the sync service uses */
export type SyncRepository = Pick<
  VaultDriver,
  'pushSyncMessagesBatch' | 'getSyncMessages' | 'getGlobalSyncMessagesAfterCursor' | 'validatePageToken'
>

export interface ItemPushResult {
  itemId: ItemId
  cursor: number
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

export interface PullSyncGlobalResult {
  results: ItemPullResult[]
  hasMore: boolean
  nextPageToken?: PageToken
  scannedThroughCursor: number
}

export interface PollSyncResult {
  success: true
  pushResults: ItemPushResult[]
  pullResults: ItemPullResult[]
  hasMore: boolean
  globalNextPageToken: PageToken | undefined
  globalHasMore: boolean
  globalScannedThroughCursor: number | undefined
}

export const DEFAULT_PULL_BATCH_CONCURRENCY = 10

const TIMESTAMP_MULTIPLIER = 10_000_000
const MAX_OFFSET = 9_999_000
const CUSTOM_EPOCH = 1760000000000 // 2025-10-09T08:53:20.000Z. Never change it: cursors must keep increasing

/**
 * Pulls leave out messages stamped in the last `SYNC_SETTLE_MS`. A message's cursor is fixed when its
 * push starts, but the write can take seconds and the account-wide pull reads an eventually
 * consistent index, so a pull could otherwise return a later message first and move the client's
 * cursor past this one (docs/sync-design.md). Longer than a push's worst-case unprocessed-item retries.
 */
export const SYNC_SETTLE_MS = 5_000

/** The highest cursor of the last whole second that ended at least `settleMs` before `now` */
export function settledCursorAt(now: number, settleMs: number): number {
  const settledSeconds = Math.floor(Math.max(0, now - settleMs - CUSTOM_EPOCH) / 1000)
  return settledSeconds * TIMESTAMP_MULTIPLIER - 1
}

/** The cursor a client reaches after `messages` (which are in cursor order), starting from `fromCursor` */
function nextCursorAfter(messages: StoredSyncMessage[], fromCursor: number): number {
  return messages.at(-1)?.cursor ?? fromCursor
}

/**
 * The first cursor for a batch pushed at `timestamp`: whole seconds since CUSTOM_EPOCH, plus a
 * random offset so that concurrent pushes in the same second are unlikely to collide
 */
function baseCursorAt(timestamp: number): number {
  const relativeTimestampSeconds = Math.floor(Math.max(0, timestamp - CUSTOM_EPOCH) / 1000)
  const invocationOffset = Math.floor(Math.random() * MAX_OFFSET)
  return relativeTimestampSeconds * TIMESTAMP_MULTIPLIER + invocationOffset
}

export async function pushSyncBatch(
  vault: SyncRepository,
  input: PushSyncBatchInput,
): Promise<ItemPushResult[]> {
  const timestamp = Date.now()
  const baseCursor = baseCursorAt(timestamp)

  const storedMessages: PushSyncMessagesInput['messages'] = []
  const results: ItemPushResult[] = []
  for (const [index, { itemId, encryptedMessage }] of input.messages.entries()) {
    const cursor = baseCursor + index
    storedMessages.push({
      itemId,
      entry: { cursor, encryptedMessage, createdAt: timestamp },
    })
    results.push({ itemId, cursor })
  }

  await vault.pushSyncMessagesBatch({ account: input.account, messages: storedMessages })

  return results
}

async function pullItemSyncMessages(
  vault: SyncRepository,
  input: PullSyncMessageInput,
): Promise<ItemPullResult> {
  // The page size is the driver's to choose
  const { messages, hasMore, nextPageToken } = await vault.getSyncMessages({
    account: input.account,
    itemId: input.itemId,
    fromCursor: input.cursor,
    throughCursor: input.throughCursor,
    pageToken: input.pageToken,
  })

  return {
    success: true,
    itemId: input.itemId,
    nextCursor: nextCursorAfter(messages, input.cursor),
    messages,
    hasMore,
    nextPageToken,
  }
}

export async function pullSyncBatch(
  vault: SyncRepository,
  input: PullSyncBatchInput,
): Promise<ItemPullResult[]> {
  const dedupedCursorsByItemId = new Map<ItemId, { cursor: number; pageToken?: PageToken }>()
  for (const cursorInput of input.cursors) {
    const fromCursor = cursorInput.cursor ?? 0
    const existing = dedupedCursorsByItemId.get(cursorInput.itemId)
    if (!existing || fromCursor >= existing.cursor) {
      dedupedCursorsByItemId.set(cursorInput.itemId, {
        cursor: fromCursor,
        pageToken: cursorInput.pageToken,
      })
    }
  }

  return mapWithConcurrency(
    Array.from(dedupedCursorsByItemId.entries()),
    DEFAULT_PULL_BATCH_CONCURRENCY,
    ([itemId, { cursor, pageToken }]) => pullItemSyncMessages(vault, {
      account: input.account,
      itemId,
      cursor,
      throughCursor: input.throughCursor,
      pageToken,
    }),
  )
}

export async function pullSyncGlobal(
  vault: SyncRepository,
  input: PullSyncGlobalInput,
): Promise<PullSyncGlobalResult> {
  const { items, hasMore, nextPageToken, scannedThroughCursor } = await vault.getGlobalSyncMessagesAfterCursor({
    account: input.account,
    cursor: input.cursor,
    throughCursor: input.throughCursor,
    pageToken: input.pageToken,
  })

  const results = items.map(({ itemId, messages }): ItemPullResult => ({
    success: true,
    itemId,
    nextCursor: nextCursorAfter(messages, input.cursor),
    messages,
    hasMore: false,
  }))

  return { results, hasMore, nextPageToken, scannedThroughCursor }
}

/**
 * Pushes the client's messages, then pulls the items it is catching up on (`pullCursors`) and the
 * account-wide changes after `clientLatestCursor` in parallel. Throws `InvalidPageTokenError`
 * before storing anything if a page token is bad, or the client would push its messages again.
 */
export async function pollSync(
  vault: SyncRepository,
  input: PollSyncInput,
  { settleMs = SYNC_SETTLE_MS, now = Date.now() }: PollSyncOptions = {},
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
    ? await pushSyncBatch(vault, { account: input.account, messages: input.pushMessages })
    : []

  // One bound for both pulls, so per-item and account-wide results agree
  const throughCursor = settledCursorAt(now, settleMs)
  const shouldPullBatch = input.pullCursors.length > 0
  const shouldPullGlobal = typeof input.clientLatestCursor === 'number' || !!input.globalPageToken
  const [batchPullResults, globalPullResult] = await Promise.all([
    shouldPullBatch
      ? pullSyncBatch(vault, { account: input.account, cursors: input.pullCursors, throughCursor })
      : null,
    shouldPullGlobal
      ? pullSyncGlobal(vault, {
        account: input.account,
        cursor: input.clientLatestCursor ?? 0,
        throughCursor,
        pageToken: input.globalPageToken,
      })
      : null,
  ])

  // Items being pulled on their own are left out of the global results, so that a lagging item's
  // cursor doesn't jump past messages it hasn't caught up on yet
  const pullCursorItemIds = new Set(input.pullCursors.map(c => c.itemId))
  const globalResults = (globalPullResult?.results ?? []).filter(r => !pullCursorItemIds.has(r.itemId))
  const pullResults = [...(batchPullResults ?? []), ...globalResults]
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
