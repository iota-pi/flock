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

export interface PersistedSyncCursors {
  globalCursor: number
  retries?: [ItemId, number][]
}

export class PullRetryTracker {
  public static readonly MAX_PULL_RETRIES = 5

  private globalCursor = 0
  private readonly retryQueue = new Map<ItemId, ItemPullState>()
  private readonly itemCursors = new Map<ItemId, number>()

  constructor(private readonly maxRetries: number = PullRetryTracker.MAX_PULL_RETRIES) {}

  getOrCreateState(itemId: ItemId): ItemPullState {
    let state = this.retryQueue.get(itemId)
    if (!state) {
      const knownCursor = this.itemCursors.get(itemId) ?? 0
      state = {
        cursor: knownCursor,
        pending: false,
        retryCount: 0,
      }
      this.retryQueue.set(itemId, state)
    }
    return state
  }

  hasState(itemId: ItemId): boolean {
    return this.retryQueue.has(itemId)
  }

  getState(itemId: ItemId): ItemPullState | undefined {
    const existing = this.retryQueue.get(itemId)
    if (existing) return existing
    const knownCursor = this.itemCursors.get(itemId)
    if (typeof knownCursor === 'number') {
      return {
        cursor: knownCursor,
        pending: false,
        retryCount: 0,
      }
    }
    return undefined
  }

  getCursor(itemId: ItemId): number {
    return this.retryQueue.get(itemId)?.cursor ?? this.itemCursors.get(itemId) ?? 0
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
    for (const state of this.retryQueue.values()) {
      if (state.retryCount > 0 || (state.blockedOnKey && !hasVaultKey(state.blockedOnKey))) {
        return true
      }
    }
    return false
  }

  hasPendingPulls(): boolean {
    for (const state of this.retryQueue.values()) {
      if (state.pending) return true
    }
    return false
  }

  hasImmediatePendingPulls(): boolean {
    for (const state of this.retryQueue.values()) {
      if (state.pending && state.retryCount === 0 && (!state.blockedOnKey || hasVaultKey(state.blockedOnKey))) {
        return true
      }
    }
    return false
  }

  onKeyringUpdated(): boolean {
    let unblockedAny = false
    for (const state of this.retryQueue.values()) {
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

    for (const [itemId, state] of this.retryQueue.entries()) {
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
    if (Number.isFinite(cursor) && cursor >= 0) {
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
      globalCursor: this.getGlobalLatestCursor(),
      retries: retries.length > 0 ? retries : undefined,
    }
  }

  loadState(stored: PersistedSyncCursors | [ItemId, number][]): void {
    if (Array.isArray(stored)) {
      this.loadStoredCursors(stored)
      return
    }
    if (stored && typeof stored === 'object') {
      if (typeof stored.globalCursor === 'number' && Number.isFinite(stored.globalCursor)) {
        this.globalCursor = Math.max(this.globalCursor, stored.globalCursor)
      }
      if (Array.isArray(stored.retries)) {
        for (const [itemId, cursor] of stored.retries) {
          if (Number.isFinite(cursor) && cursor >= 0) {
            const state = this.getOrCreateState(itemId)
            state.cursor = Math.max(state.cursor, cursor)
            state.pending = true
            const current = this.itemCursors.get(itemId) ?? 0
            this.itemCursors.set(itemId, Math.max(current, cursor))
          }
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

  exportValidCursors(): [ItemId, number][] {
    const data: [ItemId, number][] = []
    const seen = new Set<ItemId>()
    for (const [itemId, state] of this.retryQueue.entries()) {
      if (state.cursor >= 0) {
        data.push([itemId, state.cursor])
        seen.add(itemId)
      }
    }
    for (const [itemId, cursor] of this.itemCursors.entries()) {
      if (!seen.has(itemId) && cursor >= 0) {
        data.push([itemId, cursor])
        seen.add(itemId)
      }
    }
    return data
  }

  importCursors(cursors: [ItemId, number][]): void {
    this.retryQueue.clear()
    this.itemCursors.clear()
    for (const [itemId, cursor] of cursors) {
      if (Number.isFinite(cursor) && cursor >= 0) {
        this.globalCursor = Math.max(this.globalCursor, cursor)
        this.itemCursors.set(itemId, cursor)
        const state = this.getOrCreateState(itemId)
        state.cursor = cursor
      }
    }
  }

  loadStoredCursors(stored: [ItemId, number][]): void {
    for (const [itemId, cursor] of stored) {
      if (Number.isFinite(cursor) && cursor >= 0) {
        this.globalCursor = Math.max(this.globalCursor, cursor)
        const current = this.itemCursors.get(itemId) ?? 0
        this.itemCursors.set(itemId, Math.max(current, cursor))
        const state = this.retryQueue.get(itemId)
        if (state) {
          state.cursor = Math.max(state.cursor, cursor)
        }
      }
    }
  }

  clear(): void {
    this.globalCursor = 0
    this.retryQueue.clear()
    this.itemCursors.clear()
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
      if (highestCursor > state.cursor) {
        state.cursor = highestCursor
      }
      this.setGlobalCursor(highestCursor)
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
        state.cursor = highestCursor
        this.retryQueue.delete(itemId)
        this.setGlobalCursor(highestCursor)
      } else {
        state.pending = true
        if (highestCursor > state.cursor) {
          state.cursor = highestCursor
        }
      }
    } else {
      // Terminal success (hasMore: false, no failure)
      state.pending = false
      state.retryCount = 0
      state.blockedOnKey = undefined
      state.lastEvaluatedKey = undefined
      state.cursor = highestCursor
      this.retryQueue.delete(itemId)
      this.setGlobalCursor(highestCursor)
    }

    let cursorUpdated = false
    if (highestCursor > initialCursor) {
      state.cursor = highestCursor
      this.itemCursors.set(itemId, highestCursor)
      cursorUpdated = true
    } else if (isNewItem && highestCursor >= 0) {
      state.cursor = highestCursor
      this.itemCursors.set(itemId, highestCursor)
      cursorUpdated = true
    }

    return {
      cursorUpdated,
      permanentlyFailed,
      advanceCursor,
    }
  }
}
