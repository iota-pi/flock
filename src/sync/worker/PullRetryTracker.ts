import { hasVaultKey } from 'src/api/vault'
import { ItemId } from 'src/shared/schemas/items'

export interface ItemPullState {
  cursor: number
  pending: boolean
  retryCount: number
  blockedOnKey?: string
  lastEvaluatedKey?: Record<string, unknown>
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
  lastEvaluatedKey?: Record<string, unknown>
}

export interface RecordPullOutcomeResult {
  cursorUpdated: boolean
  permanentlyFailed: boolean
  advanceCursor?: number
}

export class PullRetryTracker {
  public static readonly MAX_PULL_RETRIES = 5

  private readonly itemStates = new Map<ItemId, ItemPullState>()

  constructor(private readonly maxRetries: number = PullRetryTracker.MAX_PULL_RETRIES) {}

  getOrCreateState(itemId: ItemId): ItemPullState {
    let state = this.itemStates.get(itemId)
    if (!state) {
      state = {
        cursor: 0,
        pending: false,
        retryCount: 0,
      }
      this.itemStates.set(itemId, state)
    }
    return state
  }

  hasState(itemId: ItemId): boolean {
    return this.itemStates.has(itemId)
  }

  getState(itemId: ItemId): ItemPullState | undefined {
    return this.itemStates.get(itemId)
  }

  getCursor(itemId: ItemId): number {
    return this.itemStates.get(itemId)?.cursor ?? 0
  }

  addPendingItem(itemId: ItemId): void {
    if (!itemId) return
    const state = this.getOrCreateState(itemId)
    state.pending = true
    if (state.blockedOnKey && hasVaultKey(state.blockedOnKey)) {
      state.blockedOnKey = undefined
    }
  }

  isAnyRetrying(): boolean {
    for (const state of this.itemStates.values()) {
      if (state.retryCount > 0 || (state.blockedOnKey && !hasVaultKey(state.blockedOnKey))) {
        return true
      }
    }
    return false
  }

  hasPendingPulls(): boolean {
    for (const state of this.itemStates.values()) {
      if (state.pending) return true
    }
    return false
  }

  hasImmediatePendingPulls(): boolean {
    for (const state of this.itemStates.values()) {
      if (state.pending && state.retryCount === 0 && (!state.blockedOnKey || hasVaultKey(state.blockedOnKey))) {
        return true
      }
    }
    return false
  }

  onKeyringUpdated(): boolean {
    let unblockedAny = false
    for (const state of this.itemStates.values()) {
      if (state.blockedOnKey && hasVaultKey(state.blockedOnKey)) {
        state.blockedOnKey = undefined
        state.pending = true
        state.retryCount = 0
        unblockedAny = true
      }
    }
    return unblockedAny
  }

  getCursors(): Array<{ itemId: ItemId; cursor: number; lastEvaluatedKey?: Record<string, unknown> }> {
    const cursors: Array<{ itemId: ItemId; cursor: number; lastEvaluatedKey?: Record<string, unknown> }> = []

    for (const [itemId, state] of this.itemStates.entries()) {
      if (state.blockedOnKey && !hasVaultKey(state.blockedOnKey)) {
        continue
      }
      if (state.pending) {
        cursors.push({ itemId, cursor: state.cursor, lastEvaluatedKey: state.lastEvaluatedKey })
      }
    }

    return cursors
  }

  getGlobalLatestCursor(): number {
    let max = 0
    for (const state of this.itemStates.values()) {
      if (state.cursor > max) max = state.cursor
    }
    return max
  }

  exportCursors(): [ItemId, number][] {
    const cursors: [ItemId, number][] = []
    for (const [itemId, state] of this.itemStates.entries()) {
      cursors.push([itemId, state.cursor])
    }
    return cursors
  }

  exportValidCursors(): [ItemId, number][] {
    const data: [ItemId, number][] = []
    for (const [itemId, state] of this.itemStates.entries()) {
      if (state.cursor >= 0) {
        data.push([itemId, state.cursor])
      }
    }
    return data
  }

  importCursors(cursors: [ItemId, number][]): void {
    this.itemStates.clear()
    for (const [itemId, cursor] of cursors) {
      const state = this.getOrCreateState(itemId)
      state.cursor = cursor
    }
  }

  loadStoredCursors(stored: [ItemId, number][]): void {
    for (const [itemId, cursor] of stored) {
      if (Number.isFinite(cursor) && cursor >= 0) {
        const state = this.getOrCreateState(itemId)
        state.cursor = Math.max(state.cursor, cursor)
      }
    }
  }

  clear(): void {
    this.itemStates.clear()
  }

  recordPullOutcome(params: RecordPullOutcomeParams): RecordPullOutcomeResult {
    const {
      itemId,
      initialCursor,
      isNewItem,
      hasKeyFailure,
      blockedOnKey,
      hasParseFailure,
      failingCursor,
      hasMore,
      nextCursor,
      lastEvaluatedKey,
    } = params

    const state = this.getOrCreateState(itemId)
    let highestCursor = params.highestCursor
    let permanentlyFailed = false
    let advanceCursor: number | undefined

    if (hasKeyFailure) {
      state.pending = true
      state.lastEvaluatedKey = undefined
      if (blockedOnKey) {
        state.blockedOnKey = blockedOnKey
      }
    } else if (hasMore && !hasParseFailure) {
      state.pending = true
      state.retryCount = 0
      state.blockedOnKey = undefined
      state.lastEvaluatedKey = lastEvaluatedKey
    } else if (hasParseFailure) {
      state.lastEvaluatedKey = undefined
      state.retryCount += 1

      if (state.retryCount >= this.maxRetries) {
        state.pending = false
        state.retryCount = 0
        permanentlyFailed = true

        advanceCursor = Number.isFinite(failingCursor)
          ? (failingCursor as number)
          : typeof nextCursor === 'number' && Number.isFinite(nextCursor)
            ? nextCursor
            : undefined

        if (typeof advanceCursor === 'number') {
          highestCursor = Math.max(highestCursor, advanceCursor)
        }
      } else {
        state.pending = true
      }
    } else {
      state.pending = false
      state.retryCount = 0
      state.blockedOnKey = undefined
      state.lastEvaluatedKey = undefined
    }

    let cursorUpdated = false
    if (highestCursor > initialCursor) {
      state.cursor = highestCursor
      cursorUpdated = true
    } else if (isNewItem && highestCursor >= 0) {
      state.cursor = highestCursor
      cursorUpdated = true
    }

    return {
      cursorUpdated,
      permanentlyFailed,
      advanceCursor,
    }
  }
}
