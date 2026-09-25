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

export type PullOutcomeKind =
  | 'key-failure'
  | 'partial-success'
  | 'parse-failure-retry'
  | 'parse-failure-exhausted'
  | 'terminal-success'

export interface PullStateTransition {
  kind: PullOutcomeKind
  targetCursor: number
  effectiveHighestCursor: number
  pending: boolean
  retryCount: number
  blockedOnKey?: string
  lastEvaluatedKey?: Record<string, unknown>
  permanentlyFailed: boolean
  advanceCursor?: number
  cursorUpdated: boolean
  removeFromRetryQueue: boolean
  updateGlobalCursor: boolean
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
      lastEvaluatedKey,
    } = outcome

    let highestCursor = outcome.highestCursor
    let kind: PullOutcomeKind
    let pending: boolean
    let retryCount = state.retryCount
    let nextBlockedOnKey = state.blockedOnKey
    let nextLastEvaluatedKey: Record<string, unknown> | undefined
    let permanentlyFailed = false
    let advanceCursor: number | undefined
    let removeFromRetryQueue = false
    let updateGlobalCursor = false
    let targetCursor = state.cursor

    if (hasKeyFailure) {
      kind = 'key-failure'
      pending = true
      nextLastEvaluatedKey = undefined
      if (blockedOnKey) {
        nextBlockedOnKey = blockedOnKey
      }
    } else if (hasMore && !hasParseFailure) {
      kind = 'partial-success'
      pending = true
      retryCount = 0
      nextBlockedOnKey = undefined
      nextLastEvaluatedKey = lastEvaluatedKey
      if (highestCursor > targetCursor) {
        targetCursor = highestCursor
      }
      updateGlobalCursor = true
    } else if (hasParseFailure) {
      nextLastEvaluatedKey = undefined
      const nextRetries = state.retryCount + 1

      if (nextRetries >= maxRetries) {
        kind = 'parse-failure-exhausted'
        pending = false
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
        removeFromRetryQueue = true
        updateGlobalCursor = true
      } else {
        kind = 'parse-failure-retry'
        pending = true
        retryCount = nextRetries
        if (highestCursor > targetCursor) {
          targetCursor = highestCursor
        }
      }
    } else {
      // Terminal success (hasMore: false, no failure)
      kind = 'terminal-success'
      pending = false
      retryCount = 0
      nextBlockedOnKey = undefined
      nextLastEvaluatedKey = undefined
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
      kind,
      targetCursor,
      effectiveHighestCursor: highestCursor,
      pending,
      retryCount,
      blockedOnKey: nextBlockedOnKey,
      lastEvaluatedKey: nextLastEvaluatedKey,
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
    state.lastEvaluatedKey = transition.lastEvaluatedKey
  }

  advanceGlobalCursor(itemId: ItemId, transition: PullStateTransition): void {
    if (transition.cursorUpdated) {
      this.itemCursors.set(itemId, transition.targetCursor)
    }
    if (transition.removeFromRetryQueue) {
      this.retryQueue.delete(itemId)
    }
    if (transition.updateGlobalCursor) {
      this.setGlobalCursor(transition.effectiveHighestCursor)
    }
  }

  recordPullOutcome(params: RecordPullOutcomeParams): RecordPullOutcomeResult
  recordPullOutcome(itemId: ItemId, outcome: Omit<RecordPullOutcomeParams, 'itemId'>): RecordPullOutcomeResult
  recordPullOutcome(
    itemIdOrParams: ItemId | RecordPullOutcomeParams,
    outcome?: Omit<RecordPullOutcomeParams, 'itemId'>
  ): RecordPullOutcomeResult {
    const params: RecordPullOutcomeParams =
      typeof itemIdOrParams === 'string'
        ? { itemId: itemIdOrParams, ...outcome! }
        : itemIdOrParams

    const { itemId } = params
    const state = this.getOrCreateState(itemId)
    const transition = this.computeTransition(state, params)
    this.applyTransition(state, transition)
    this.advanceGlobalCursor(itemId, transition)

    return {
      cursorUpdated: transition.cursorUpdated,
      permanentlyFailed: transition.permanentlyFailed,
      advanceCursor: transition.advanceCursor,
    }
  }
}
