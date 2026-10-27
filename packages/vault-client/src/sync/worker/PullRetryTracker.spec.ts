import { PullRetryTracker, PullStateTransition } from './PullRetryTracker'
import { ItemId } from '@vault/shared'
import { createMockKeyProvider, createMockVault } from './__test__/testUtils'

const mockVault = createMockVault()
const mockHasVaultKey = mockVault.hasVaultKey
const keys = createMockKeyProvider(mockVault)

describe('PullRetryTracker', () => {
  let tracker: PullRetryTracker

  beforeEach(() => {
    vi.clearAllMocks()
    mockHasVaultKey.mockReturnValue(true)
    tracker = new PullRetryTracker(keys)
  })

  describe('state initialization and queries', () => {
    it('creates default state on demand', () => {
      expect(tracker.hasState('item-1' as ItemId)).toBe(false)
      expect(tracker.getCursor('item-1' as ItemId)).toBe(0)

      const state = tracker.getOrCreateState('item-1' as ItemId)
      expect(state).toEqual({
        cursor: 0,
        pending: false,
        retryCount: 0,
      })
      expect(tracker.hasState('item-1' as ItemId)).toBe(true)
      expect(tracker.getState('item-1' as ItemId)).toBe(state)
    })

    it('reports a default state for known cursors without queueing the item', () => {
      expect(tracker.getState('item-1' as ItemId)).toBeUndefined()

      tracker.importCursors([['item-1' as ItemId, 40]])
      tracker.recordPullOutcome({
        itemId: 'item-1' as ItemId,
        initialCursor: 40,
        highestCursor: 60,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: false,
      })

      expect(tracker.getState('item-1' as ItemId)).toEqual({ cursor: 60, pending: false, retryCount: 0 })
      expect(tracker.hasState('item-1' as ItemId)).toBe(false)
    })

    it('adds pending items and ignores empty id', () => {
      tracker.addPendingItem('' as ItemId)
      expect(tracker.hasImmediatePendingPulls()).toBe(false)

      tracker.addPendingItem('item-1' as ItemId)
      expect(tracker.getState('item-1' as ItemId)?.pending).toBe(true)
      expect(tracker.hasImmediatePendingPulls()).toBe(true)
    })

    it('unblocks blockedOnKey if key is available when adding pending item', () => {
      mockHasVaultKey.mockReturnValue(true)
      const state = tracker.getOrCreateState('item-1' as ItemId)
      state.blockedOnKey = 'key-1'

      tracker.addPendingItem('item-1' as ItemId)
      expect(state.blockedOnKey).toBeUndefined()
      expect(state.pending).toBe(true)
    })
  })

  describe('retrying and immediate pulls evaluation', () => {
    it('reports isAnyRetrying correctly', () => {
      expect(tracker.isAnyRetrying()).toBe(false)

      const state = tracker.getOrCreateState('item-1' as ItemId)
      state.retryCount = 1
      expect(tracker.isAnyRetrying()).toBe(true)

      state.retryCount = 0
      expect(tracker.isAnyRetrying()).toBe(false)

      state.blockedOnKey = 'missing-key'
      mockHasVaultKey.mockReturnValue(false)
      expect(tracker.isAnyRetrying()).toBe(true)

      mockHasVaultKey.mockReturnValue(true)
      expect(tracker.isAnyRetrying()).toBe(false)
    })

    it('reports hasImmediatePendingPulls correctly', () => {
      const state = tracker.getOrCreateState('item-1' as ItemId)
      state.pending = true
      expect(tracker.hasImmediatePendingPulls()).toBe(true)

      // In retry backoff (retryCount > 0)
      state.retryCount = 1
      expect(tracker.hasImmediatePendingPulls()).toBe(false)

      // Blocked on key
      state.retryCount = 0
      state.blockedOnKey = 'missing-key'
      mockHasVaultKey.mockReturnValue(false)
      expect(tracker.hasImmediatePendingPulls()).toBe(false)

      mockHasVaultKey.mockReturnValue(true)
      expect(tracker.hasImmediatePendingPulls()).toBe(true)
    })
  })

  describe('keyring unblocking', () => {
    it('unblocks blocked items when key becomes available', () => {
      const state = tracker.getOrCreateState('item-1' as ItemId)
      state.blockedOnKey = 'key-2'
      state.pending = false
      state.retryCount = 2

      mockHasVaultKey.mockReturnValue(false)
      expect(tracker.onKeyringUpdated()).toBe(false)

      mockHasVaultKey.mockReturnValue(true)
      const unblocked = tracker.onKeyringUpdated()
      expect(unblocked).toBe(true)
      expect(state.blockedOnKey).toBeUndefined()
      expect(state.pending).toBe(true)
      expect(state.retryCount).toBe(0)
    })
  })

  describe('getCursors and global cursors', () => {
    it('returns only pending and unblocked cursors', () => {
      const s1 = tracker.getOrCreateState('item-1' as ItemId)
      s1.cursor = 10
      s1.pending = true

      const s2 = tracker.getOrCreateState('item-2' as ItemId)
      s2.cursor = 20
      s2.pending = false

      const s3 = tracker.getOrCreateState('item-3' as ItemId)
      s3.cursor = 30
      s3.pending = true
      s3.blockedOnKey = 'missing-k'
      mockHasVaultKey.mockImplementation((k: string) => k !== 'missing-k')

      const cursors = tracker.getCursors()
      expect(cursors).toEqual([{ itemId: 'item-1', cursor: 10, pageToken: undefined }])
    })

    it('returns global latest cursor', () => {
      tracker.getOrCreateState('item-1' as ItemId).cursor = 50
      tracker.getOrCreateState('item-2' as ItemId).cursor = 120
      tracker.getOrCreateState('item-3' as ItemId).cursor = 80

      expect(tracker.getGlobalLatestCursor()).toBe(120)
    })
  })

  describe('import, export, and load', () => {
    it('exports and imports cursors', () => {
      tracker.getOrCreateState('item-1' as ItemId).cursor = 10
      tracker.getOrCreateState('item-2' as ItemId).cursor = 20

      const exported = tracker.exportCursors()
      expect(exported).toEqual([
        ['item-1', 10],
        ['item-2', 20],
      ])

      const tracker2 = new PullRetryTracker(keys)
      tracker2.importCursors(exported)
      expect(tracker2.exportCursors()).toEqual(exported)
    })

    it('loads stored retries monotonically without regressing', () => {
      tracker.setGlobalCursor(500)
      tracker.getOrCreateState('item-1' as ItemId).cursor = 50
      tracker.loadState({
        globalCursor: 100, // lower, should not regress
        retries: [
          ['item-1' as ItemId, 20], // lower, should not regress
          ['item-2' as ItemId, 30], // new, should be accepted
          ['item-3' as ItemId, -1], // invalid, should be ignored
        ],
      })

      expect(tracker.getGlobalScanCursor()).toBe(500)
      expect(tracker.getCursor('item-1' as ItemId)).toBe(50)
      expect(tracker.getCursor('item-2' as ItemId)).toBe(30)
      expect(tracker.hasState('item-3' as ItemId)).toBe(false)
    })
  })

  describe('recordPullOutcome', () => {
    it('handles key failure outcome', () => {
      const outcome = tracker.recordPullOutcome({
        itemId: 'item-1' as ItemId,
        initialCursor: 0,
        highestCursor: 0,
        isNewItem: true,
        hasKeyFailure: true,
        blockedOnKey: 'kver-2',
        hasParseFailure: false,
        hasMore: false,
      })

      const state = tracker.getState('item-1' as ItemId)
      expect(state?.pending).toBe(true)
      expect(state?.blockedOnKey).toBe('kver-2')
      expect(outcome.cursorUpdated).toBe(true) // isNewItem && highestCursor >= 0
      expect(outcome.permanentlyFailed).toBe(false)
    })

    it('handles pagination success outcome (hasMore: true)', () => {
      const evalKey = 'item-page-token'
      const outcome = tracker.recordPullOutcome({
        itemId: 'item-page' as ItemId,
        initialCursor: 0,
        highestCursor: 100,
        isNewItem: true,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: true,
        pageToken: evalKey,
      })

      const state = tracker.getState('item-page' as ItemId)
      expect(state?.pending).toBe(true)
      expect(state?.pageToken).toEqual(evalKey)
      expect(state?.cursor).toBe(100)
      expect(outcome.cursorUpdated).toBe(true)
      expect(outcome.permanentlyFailed).toBe(false)
    })

    it('handles terminal success outcome (hasMore: false)', () => {
      const outcome = tracker.recordPullOutcome({
        itemId: 'item-done' as ItemId,
        initialCursor: 100,
        highestCursor: 150,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: false,
      })

      const state = tracker.getState('item-done' as ItemId)
      expect(state?.pending).toBe(false)
      expect(state?.pageToken).toBeUndefined()
      expect(state?.cursor).toBe(150)
      expect(outcome.cursorUpdated).toBe(true)
      expect(outcome.permanentlyFailed).toBe(false)
    })

    it('increments retryCount and remains pending on transient parse failures (attempts 1 to 4)', () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const outcome = tracker.recordPullOutcome({
          itemId: 'item-retry' as ItemId,
          initialCursor: 0,
          highestCursor: 0,
          isNewItem: attempt === 1,
          hasKeyFailure: false,
          hasParseFailure: true,
          failingCursor: 10,
          hasMore: false,
        })

        const state = tracker.getState('item-retry' as ItemId)
        expect(state?.retryCount).toBe(attempt)
        expect(state?.pending).toBe(true)
        expect(outcome.permanentlyFailed).toBe(false)
      }
    })

    it('marks permanently failed on 5th consecutive parse failure and advances cursor past failing message', () => {
      const state = tracker.getOrCreateState('item-fail5' as ItemId)
      state.retryCount = 4

      const outcome = tracker.recordPullOutcome({
        itemId: 'item-fail5' as ItemId,
        initialCursor: 0,
        highestCursor: 0,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: true,
        failingCursor: 25,
        hasMore: false,
      })

      expect(outcome.permanentlyFailed).toBe(true)
      expect(outcome.advanceCursor).toBe(25)
      expect(state.pending).toBe(false)
      expect(state.retryCount).toBe(0)
      expect(state.cursor).toBe(25)
      expect(outcome.cursorUpdated).toBe(true)
    })

    it('falls back to nextCursor if failingCursor is omitted on 5th failure', () => {
      const state = tracker.getOrCreateState('item-fail-fallback' as ItemId)
      state.retryCount = 4

      const outcome = tracker.recordPullOutcome({
        itemId: 'item-fail-fallback' as ItemId,
        initialCursor: 0,
        highestCursor: 0,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: true,
        nextCursor: 40,
        hasMore: false,
      })

      expect(outcome.permanentlyFailed).toBe(true)
      expect(outcome.advanceCursor).toBe(40)
      expect(state.cursor).toBe(40)
    })

    it('evicts healthy items from retryQueue on success while advancing globalCursor', () => {
      tracker.addPendingItem('item-healthy' as ItemId)
      expect(tracker.getState('item-healthy' as ItemId)?.pending).toBe(true)
      expect(tracker.hasState('item-healthy' as ItemId)).toBe(true)

      const outcome = tracker.recordPullOutcome({
        itemId: 'item-healthy' as ItemId,
        initialCursor: 0,
        highestCursor: 500,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: false,
      })

      expect(outcome.cursorUpdated).toBe(true)
      expect(tracker.hasState('item-healthy' as ItemId)).toBe(false)
      expect(tracker.hasImmediatePendingPulls()).toBe(false)
      expect(tracker.getGlobalLatestCursor()).toBe(500)
      expect(tracker.getCursors()).toEqual([])
    })
  })

  describe('global cursor and state persistence', () => {
    it('sets global cursor monotonically', () => {
      tracker.setGlobalCursor(100)
      expect(tracker.getGlobalLatestCursor()).toBe(100)

      tracker.setGlobalCursor(50) // lower, should not regress
      expect(tracker.getGlobalLatestCursor()).toBe(100)

      tracker.setGlobalCursor(250)
      expect(tracker.getGlobalLatestCursor()).toBe(250)
    })

    it('exports and loads state with globalCursor and active retries', () => {
      tracker.setGlobalCursor(1000)
      tracker.addPendingItem('item-retrying' as ItemId)
      const s = tracker.getOrCreateState('item-retrying' as ItemId)
      s.cursor = 400

      const state = tracker.exportState()
      expect(state.globalCursor).toBe(1000)
      expect(state.retries).toEqual([['item-retrying', 400]])

      const tracker2 = new PullRetryTracker(keys)
      tracker2.loadState(state)
      expect(tracker2.getGlobalLatestCursor()).toBe(1000)
      expect(tracker2.getState('item-retrying' as ItemId)?.pending).toBe(true)
      expect(tracker2.getCursors()).toEqual([{ itemId: 'item-retrying', cursor: 400, pageToken: undefined }])
    })

    it('does not raise the global scan cursor from per-item outcomes when advanceGlobalCursor is false', () => {
      tracker.setGlobalCursor(100)
      tracker.recordPullOutcome({
        itemId: 'item-ahead' as ItemId,
        initialCursor: 0,
        highestCursor: 500,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: false,
        advanceGlobalCursor: false,
      })

      expect(tracker.getGlobalScanCursor()).toBe(100)
      expect(tracker.getGlobalLatestCursor()).toBe(500)
    })

    it('persists the global scan position rather than the highest per-item cursor', () => {
      tracker.setGlobalCursor(100)
      tracker.addPendingItem('item-ahead' as ItemId)
      tracker.getOrCreateState('item-ahead' as ItemId).cursor = 500

      const state = tracker.exportState()
      expect(state.globalCursor).toBe(100)
      expect(state.retries).toEqual([['item-ahead', 500]])

      const restored = new PullRetryTracker(keys)
      restored.loadState(state)
      expect(restored.getGlobalScanCursor()).toBe(100)
    })
  })

  describe('computeTransition', () => {
    it('computes key-failure transition without mutating original state', () => {
      const state = {
        cursor: 10,
        pending: false,
        retryCount: 2,
        blockedOnKey: 'old-key',
      }
      const originalCopy = { ...state }

      const transition = tracker.computeTransition(state, {
        itemId: 'item-1' as ItemId,
        initialCursor: 10,
        highestCursor: 10,
        isNewItem: false,
        hasKeyFailure: true,
        blockedOnKey: 'new-key',
        hasParseFailure: false,
        hasMore: false,
      })

      expect(state).toEqual(originalCopy)
      expect(transition).toEqual({
        targetCursor: 10,
        effectiveHighestCursor: 10,
        pending: true,
        retryCount: 2,
        blockedOnKey: 'new-key',
        pageToken: undefined,
        permanentlyFailed: false,
        advanceCursor: undefined,
        cursorUpdated: false,
        removeFromRetryQueue: false,
        updateGlobalCursor: false,
      })
    })

    it('computes partial-success transition with pagination and global cursor flag', () => {
      const state = {
        cursor: 50,
        pending: true,
        retryCount: 1,
        blockedOnKey: 'some-key',
      }
      const evalKey = 'item-1-page-token'

      const transition = tracker.computeTransition(state, {
        itemId: 'item-1' as ItemId,
        initialCursor: 50,
        highestCursor: 120,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: true,
        pageToken: evalKey,
      })

      expect(transition).toEqual({
        targetCursor: 120,
        effectiveHighestCursor: 120,
        pending: true,
        retryCount: 0,
        blockedOnKey: undefined,
        pageToken: evalKey,
        permanentlyFailed: false,
        advanceCursor: undefined,
        cursorUpdated: true,
        removeFromRetryQueue: false,
        updateGlobalCursor: true,
      })
    })

    it('computes parse-failure-retry transition when retries are under the limit', () => {
      const state = {
        cursor: 10,
        pending: false,
        retryCount: 1,
      }

      const transition = tracker.computeTransition(state, {
        itemId: 'item-1' as ItemId,
        initialCursor: 10,
        highestCursor: 10,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: true,
        hasMore: false,
      })

      expect(transition.pending).toBe(true)
      expect(transition.retryCount).toBe(2)
      expect(transition.permanentlyFailed).toBe(false)
      expect(transition.removeFromRetryQueue).toBe(false)
      expect(transition.updateGlobalCursor).toBe(false)
    })

    it('computes parse-failure-exhausted transition with failingCursor fallback', () => {
      const state = {
        cursor: 10,
        pending: true,
        retryCount: 4,
      }

      const transition = tracker.computeTransition(
        state,
        {
          itemId: 'item-1' as ItemId,
          initialCursor: 10,
          highestCursor: 10,
          isNewItem: false,
          hasKeyFailure: false,
          hasParseFailure: true,
          failingCursor: 55,
          hasMore: false,
        },
        5
      )

      expect(transition.pending).toBe(false)
      expect(transition.retryCount).toBe(0)
      expect(transition.permanentlyFailed).toBe(true)
      expect(transition.advanceCursor).toBe(55)
      expect(transition.targetCursor).toBe(55)
      expect(transition.cursorUpdated).toBe(true)
      expect(transition.removeFromRetryQueue).toBe(true)
      expect(transition.updateGlobalCursor).toBe(true)
    })

    it('computes terminal-success transition removing item from retryQueue', () => {
      const state = {
        cursor: 50,
        pending: true,
        retryCount: 0,
      }

      const transition = tracker.computeTransition(state, {
        itemId: 'item-1' as ItemId,
        initialCursor: 50,
        highestCursor: 80,
        isNewItem: false,
        hasKeyFailure: false,
        hasParseFailure: false,
        hasMore: false,
      })

      expect(transition.pending).toBe(false)
      expect(transition.retryCount).toBe(0)
      expect(transition.targetCursor).toBe(80)
      expect(transition.cursorUpdated).toBe(true)
      expect(transition.removeFromRetryQueue).toBe(true)
      expect(transition.updateGlobalCursor).toBe(true)
    })
  })

  describe('applyTransition', () => {
    it('mutates ItemPullState according to transition values', () => {
      const state = {
        cursor: 0,
        pending: true,
        retryCount: 3,
        blockedOnKey: 'k1',
        pageToken: 'item-1-page-token',
      }

      const transition: PullStateTransition = {
        targetCursor: 200,
        effectiveHighestCursor: 200,
        pending: false,
        retryCount: 0,
        blockedOnKey: undefined,
        pageToken: undefined,
        permanentlyFailed: false,
        advanceCursor: undefined,
        cursorUpdated: true,
        removeFromRetryQueue: true,
        updateGlobalCursor: true,
      }

      tracker.applyTransition(state, transition)

      expect(state).toEqual({
        cursor: 200,
        pending: false,
        retryCount: 0,
        blockedOnKey: undefined,
        pageToken: undefined,
      })
    })
  })

  describe('advanceGlobalCursor', () => {
    it('updates itemCursors, removes from retryQueue, and advances globalCursor', () => {
      tracker.addPendingItem('item-adv' as ItemId)
      expect(tracker.hasState('item-adv' as ItemId)).toBe(true)

      const transition: PullStateTransition = {
        targetCursor: 350,
        effectiveHighestCursor: 350,
        pending: false,
        retryCount: 0,
        permanentlyFailed: false,
        cursorUpdated: true,
        removeFromRetryQueue: true,
        updateGlobalCursor: true,
      }

      tracker.advanceGlobalCursor('item-adv' as ItemId, transition)

      expect(tracker.getCursor('item-adv' as ItemId)).toBe(350)
      expect(tracker.hasState('item-adv' as ItemId)).toBe(false)
      expect(tracker.getGlobalLatestCursor()).toBe(350)
    })

    it('does not mutate itemCursors or remove from retryQueue when flags are false', () => {
      tracker.addPendingItem('item-keep' as ItemId)
      expect(tracker.hasState('item-keep' as ItemId)).toBe(true)

      const transition: PullStateTransition = {
        targetCursor: 50,
        effectiveHighestCursor: 50,
        pending: true,
        retryCount: 1,
        permanentlyFailed: false,
        cursorUpdated: false,
        removeFromRetryQueue: false,
        updateGlobalCursor: false,
      }

      tracker.advanceGlobalCursor('item-keep' as ItemId, transition)

      expect(tracker.hasState('item-keep' as ItemId)).toBe(true)
      expect(tracker.getGlobalLatestCursor()).toBe(0)
    })
  })
})
