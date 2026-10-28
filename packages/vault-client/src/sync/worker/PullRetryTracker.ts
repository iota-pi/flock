import type { KeyProvider } from '../../api/Keyring'
import { ItemId } from '@vault/shared'
import type { PageToken } from '@vault/shared'
import type { PersistedSyncCursors } from './stores/CursorStore'

export interface ItemPullState {
  cursor: number
  pending: boolean
  retryCount: number
  blockedOnKey?: string
  pageToken?: PageToken
}

export interface RecordPullOutcomeParams {
  itemId: ItemId
  initialCursor: number
  highestCursor: number
  isNewItem: boolean
  hasKeyFailure: boolean
  blockedOnKey?: string
  hasParseFailure: boolean
  failingCursor?: number
  hasMore: boolean
  nextCursor?: number
  pageToken?: PageToken
  /**
   * Whether this outcome may advance the global scan cursor. Only legacy servers, which don't
   * report the global scan position, rely on per-item results for this. Defaults to true.
   */
  advanceGlobalCursor?: boolean
}

export interface RecordPullOutcomeResult {
  cursorUpdated: boolean
  permanentlyFailed: boolean
  advanceCursor?: number
}

export interface PullStateTransition {
  targetCursor: number
  effectiveHighestCursor: number
  pending: boolean
  retryCount: number
  blockedOnKey?: string
  pageToken?: PageToken
  permanentlyFailed: boolean
  advanceCursor?: number
  cursorUpdated: boolean
  removeFromRetryQueue: boolean
  updateGlobalCursor: boolean
}

function isValidCursor(cursor: number): boolean {
  return Number.isFinite(cursor) && cursor >= 0
}

function createDefaultState(cursor: number): ItemPullState {
  return { cursor, pending: false, retryCount: 0 }
}

export class PullRetryTracker {
  public static readonly MAX_PULL_RETRIES = 5

  private globalCursor = 0
  private readonly retryQueue = new Map<ItemId, ItemPullState>()
  private readonly itemCursors = new Map<ItemId, number>()

  constructor(
    private readonly keys: KeyProvider,
    private readonly maxRetries: number = PullRetryTracker.MAX_PULL_RETRIES,
  ) {}

  /** Whether the state is waiting for a key version this device doesn't have yet */
  private isBlockedOnMissingKey(state: ItemPullState): boolean {
    return !!state.blockedOnKey && !this.keys.hasKey(state.blockedOnKey)
  }

  /** Whether the state was blocked on a key version that has since arrived */
  private isUnblockedByKey(state: ItemPullState): boolean {
    return !!state.blockedOnKey && !this.isBlockedOnMissingKey(state)
  }

  getOrCreateState(itemId: ItemId): ItemPullState {
    let state = this.retryQueue.get(itemId)
    if (!state) {
      state = createDefaultState(this.itemCursors.get(itemId) ?? 0)
      this.retryQueue.set(itemId, state)
    }
    return state
  }

  hasState(itemId: ItemId): boolean {
    return this.retryQueue.has(itemId)
  }

  /** Looks up an item's state without adding it to the retry queue */
  getState(itemId: ItemId): ItemPullState | undefined {
    const existing = this.retryQueue.get(itemId)
    if (existing) return existing
    const knownCursor = this.itemCursors.get(itemId)
    return knownCursor === undefined ? undefined : createDefaultState(knownCursor)
  }

  getCursor(itemId: ItemId): number {
    return this.retryQueue.get(itemId)?.cursor ?? this.itemCursors.get(itemId) ?? 0
  }

  addPendingItem(itemId: ItemId): void {
    if (!itemId) return
    const state = this.getOrCreateState(itemId)
    state.pending = true
    if (this.isUnblockedByKey(state)) {
      state.blockedOnKey = undefined
    }
  }

  isAnyRetrying(): boolean {
    for (const state of this.retryQueue.values()) {
      if (state.retryCount > 0 || this.isBlockedOnMissingKey(state)) {
        return true
      }
    }
    return false
  }

  hasImmediatePendingPulls(): boolean {
    for (const state of this.retryQueue.values()) {
      if (state.pending && state.retryCount === 0 && !this.isBlockedOnMissingKey(state)) {
        return true
      }
    }
    return false
  }

  onKeyringUpdated(): boolean {
    let unblockedAny = false
    for (const state of this.retryQueue.values()) {
      if (this.isUnblockedByKey(state)) {
        state.blockedOnKey = undefined
        state.pending = true
        state.retryCount = 0
        unblockedAny = true
      }
    }
    return unblockedAny
  }

  getCursors(): Array<{ itemId: ItemId; cursor: number; pageToken?: PageToken }> {
    const cursors: Array<{ itemId: ItemId; cursor: number; pageToken?: PageToken }> = []

    for (const [itemId, state] of this.retryQueue.entries()) {
      if (state.pending && !this.isBlockedOnMissingKey(state)) {
        cursors.push({ itemId, cursor: state.cursor, pageToken: state.pageToken })
      }
    }

    return cursors
  }

  /**
   * Position of the account-wide scan: every message at or below this cursor has been examined
   * by a global pull. Unlike getGlobalLatestCursor, per-item cursors never raise it.
   */
  getGlobalScanCursor(): number {
    return this.globalCursor
  }

  /**
   * Highest cursor known across the global scan and every per-item cursor.
   */
  getGlobalLatestCursor(): number {
    let max = this.globalCursor
    for (const state of this.retryQueue.values()) {
      if (state.cursor > max) max = state.cursor
    }
    for (const cursor of this.itemCursors.values()) {
      if (cursor > max) max = cursor
    }
    return max
  }

  setGlobalCursor(cursor: number): void {
    if (isValidCursor(cursor)) {
      this.globalCursor = Math.max(this.globalCursor, cursor)
    }
  }

  exportState(): PersistedSyncCursors {
    const retries: [ItemId, number][] = []
    for (const [itemId, state] of this.retryQueue.entries()) {
      if (state.cursor >= 0) {
        retries.push([itemId, state.cursor])
      }
    }
    return {
      globalCursor: this.globalCursor,
      retries: retries.length > 0 ? retries : undefined,
    }
  }

  loadState(stored: PersistedSyncCursors): void {
    if (Number.isFinite(stored.globalCursor)) {
      this.globalCursor = Math.max(this.globalCursor, stored.globalCursor)
    }
    if (Array.isArray(stored.retries)) {
      for (const [itemId, cursor] of stored.retries) {
        if (isValidCursor(cursor)) {
          const state = this.getOrCreateState(itemId)
          state.cursor = Math.max(state.cursor, cursor)
          state.pending = true
          const current = this.itemCursors.get(itemId) ?? 0
          this.itemCursors.set(itemId, Math.max(current, cursor))
        }
      }
    }
  }

  exportCursors(): [ItemId, number][] {
    const cursors: [ItemId, number][] = []
    const seen = new Set<ItemId>()
    for (const [itemId, state] of this.retryQueue.entries()) {
      cursors.push([itemId, state.cursor])
      seen.add(itemId)
    }
    for (const [itemId, cursor] of this.itemCursors.entries()) {
      if (!seen.has(itemId)) {
        cursors.push([itemId, cursor])
        seen.add(itemId)
      }
    }
    return cursors
  }

  /**
   * Replaces the per-item cursors with the ones a backup carried.
   *
   * The global scan cursor is left alone. A backup's per-item cursors can run ahead of the scan
   * that produced them, and the list only covers items its device had pulled, so no value
   * derived from them proves that every other item's messages below it were applied. Messages
   * at or below an item's restored cursor are still skipped, per item, by `initialCursor`.
   *
   * Restored cursors are not retries: they go in `itemCursors`, so they don't trigger per-item
   * pulls. Items that were already waiting for a pull stay pending, from the restored cursor if
   * the backup has one.
   */
  importCursors(cursors: [ItemId, number][]): void {
    for (const [itemId, state] of this.retryQueue.entries()) {
      if (!state.pending) {
        this.retryQueue.delete(itemId)
      }
    }
    this.itemCursors.clear()
    for (const [itemId, cursor] of cursors) {
      if (isValidCursor(cursor)) {
        this.itemCursors.set(itemId, cursor)
        const pendingState = this.retryQueue.get(itemId)
        if (pendingState && pendingState.cursor !== cursor) {
          pendingState.cursor = cursor
          pendingState.pageToken = undefined
        }
      }
    }
  }

  /** Drops every per-item page token, so pending items continue from their cursors */
  clearPageTokens(): void {
    for (const state of this.retryQueue.values()) {
      state.pageToken = undefined
    }
  }

  clear(): void {
    this.globalCursor = 0
    this.retryQueue.clear()
    this.itemCursors.clear()
  }

  computeTransition(
    state: Readonly<ItemPullState>,
    outcome: RecordPullOutcomeParams,
    maxRetries: number = this.maxRetries
  ): PullStateTransition {
    const {
      initialCursor,
      isNewItem,
      hasKeyFailure,
      blockedOnKey,
      hasParseFailure,
      failingCursor,
      hasMore,
      nextCursor,
      pageToken,
    } = outcome

    let highestCursor = outcome.highestCursor
    let pending: boolean
    let retryCount = state.retryCount
    let nextBlockedOnKey = state.blockedOnKey
    let nextPageToken: PageToken | undefined
    let permanentlyFailed = false
    let advanceCursor: number | undefined
    let removeFromRetryQueue = false
    let updateGlobalCursor = false
    let targetCursor = state.cursor

    if (hasKeyFailure) {
      pending = true
      nextPageToken = undefined
      if (blockedOnKey) {
        nextBlockedOnKey = blockedOnKey
      }
    } else if (hasMore && !hasParseFailure) {
      // Partial success: more pages to fetch
      pending = true
      retryCount = 0
      nextBlockedOnKey = undefined
      nextPageToken = pageToken
      if (highestCursor > targetCursor) {
        targetCursor = highestCursor
      }
      updateGlobalCursor = true
    } else if (hasParseFailure) {
      nextPageToken = undefined
      const nextRetries = state.retryCount + 1

      if (nextRetries >= maxRetries) {
        // Retries exhausted: skip past the failing message
        retryCount = 0
        permanentlyFailed = true

        advanceCursor = Number.isFinite(failingCursor)
          ? (failingCursor as number)
          : typeof nextCursor === 'number' && Number.isFinite(nextCursor)
            ? nextCursor
            : undefined

        if (typeof advanceCursor === 'number') {
          highestCursor = Math.max(highestCursor, advanceCursor)
        }
        targetCursor = highestCursor

        // Messages after the failing one in this response were never processed, and the global
        // scan has usually passed them, so the item stays pending and the next per-item pull
        // continues after the skipped message. That is only safe when skipping moved the cursor
        // forward: otherwise the next pull would return the same message and spin, so the item
        // is dropped as before.
        if (highestCursor > state.cursor) {
          pending = true
        } else {
          pending = false
          removeFromRetryQueue = true
        }
        updateGlobalCursor = true
      } else {
        pending = true
        retryCount = nextRetries
        if (highestCursor > targetCursor) {
          targetCursor = highestCursor
        }
      }
    } else {
      // Terminal success (hasMore: false, no failure)
      pending = false
      retryCount = 0
      nextBlockedOnKey = undefined
      nextPageToken = undefined
      targetCursor = highestCursor
      removeFromRetryQueue = true
      updateGlobalCursor = true
    }

    let cursorUpdated = false
    if (highestCursor > initialCursor) {
      targetCursor = highestCursor
      cursorUpdated = true
    } else if (isNewItem && highestCursor >= 0) {
      targetCursor = highestCursor
      cursorUpdated = true
    }

    return {
      targetCursor,
      effectiveHighestCursor: highestCursor,
      pending,
      retryCount,
      blockedOnKey: nextBlockedOnKey,
      pageToken: nextPageToken,
      permanentlyFailed,
      advanceCursor,
      cursorUpdated,
      removeFromRetryQueue,
      updateGlobalCursor,
    }
  }

  applyTransition(state: ItemPullState, transition: PullStateTransition): void {
    state.cursor = transition.targetCursor
    state.pending = transition.pending
    state.retryCount = transition.retryCount
    state.blockedOnKey = transition.blockedOnKey
    state.pageToken = transition.pageToken
  }

  advanceGlobalCursor(itemId: ItemId, transition: PullStateTransition, allowGlobalAdvance = true): void {
    if (transition.cursorUpdated) {
      this.itemCursors.set(itemId, transition.targetCursor)
    }
    if (transition.removeFromRetryQueue) {
      this.retryQueue.delete(itemId)
    }
    if (transition.updateGlobalCursor && allowGlobalAdvance) {
      this.setGlobalCursor(transition.effectiveHighestCursor)
    }
  }

  recordPullOutcome(params: RecordPullOutcomeParams): RecordPullOutcomeResult {
    const { itemId } = params
    const state = this.getOrCreateState(itemId)
    const transition = this.computeTransition(state, params)
    this.applyTransition(state, transition)
    this.advanceGlobalCursor(itemId, transition, params.advanceGlobalCursor ?? true)

    return {
      cursorUpdated: transition.cursorUpdated,
      permanentlyFailed: transition.permanentlyFailed,
      advanceCursor: transition.advanceCursor,
    }
  }
}
