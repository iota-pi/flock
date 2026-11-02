import { PullCursorState } from './PullCursorState'
import type { RecordPullOutcomeParams } from './PullCursorState'
import { ItemId } from '@vault/shared'
import { createMockKeyProvider, createMockVault } from './__test__/testUtils'

const mockVault = createMockVault()
const mockHasVaultKey = mockVault.hasVaultKey
const keys = createMockKeyProvider(mockVault)

const ITEM = 'item-1' as ItemId

describe('PullCursorState', () => {
  let cursors: PullCursorState

  beforeEach(() => {
    vi.clearAllMocks()
    mockHasVaultKey.mockReturnValue(true)
    cursors = new PullCursorState(keys)
  })

  function record(itemId: ItemId, outcome: Partial<RecordPullOutcomeParams> = {}) {
    return cursors.recordPullOutcome({
      itemId,
      highestCursor: 0,
      isNewItem: false,
      hasMore: false,
      ...outcome,
    })
  }

  /** Records a parse failure (of the message at `failingCursor`) for a pull that got no further than `cursor` */
  function failParse(
    itemId: ItemId,
    cursor: number,
    { failingCursor, ...outcome }: Partial<RecordPullOutcomeParams> & { failingCursor?: number } = {},
  ) {
    return record(itemId, { highestCursor: cursor, failure: { kind: 'parseFailure', cursor: failingCursor }, ...outcome })
  }

  /** Records the transient parse failures one short of giving up */
  function failParseUntilLastRetry(itemId: ItemId, cursor: number) {
    for (let attempt = 1; attempt < PullCursorState.MAX_PULL_RETRIES; attempt += 1) {
      expect(failParse(itemId, cursor).permanentlyFailed).toBe(false)
    }
  }

  function blockOnMissingKey(itemId: ItemId, kver: string, cursor = 0) {
    mockHasVaultKey.mockImplementation((k: string) => k !== kver)
    return record(itemId, { highestCursor: cursor, failure: { kind: 'keyMissing', kver } })
  }

  /** Puts an item in the retry queue, waiting for a pull from `cursor` */
  function pendingAt(itemId: ItemId, cursor: number) {
    cursors.loadState({ globalCursor: 0, retries: [[itemId, cursor]] })
  }

  describe('state initialization and queries', () => {
    it('has no state for an unknown item until it is added', () => {
      expect(cursors.hasState(ITEM)).toBe(false)
      expect(cursors.getCursor(ITEM)).toBe(0)

      cursors.addPendingItem(ITEM)
      expect(cursors.hasState(ITEM)).toBe(true)
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 0, pageToken: undefined }])
    })

    it('keeps the cursor of a finished item without queueing it', () => {
      cursors.importCursors([[ITEM, 40]])
      record(ITEM, { highestCursor: 60 })

      expect(cursors.getCursor(ITEM)).toBe(60)
      expect(cursors.hasState(ITEM)).toBe(false)
      expect(cursors.getPendingPulls()).toEqual([])
      expect(cursors.exportCursors()).toEqual([[ITEM, 60]])
    })

    it('adds pending items and ignores empty id', () => {
      cursors.addPendingItem('' as ItemId)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)

      cursors.addPendingItem(ITEM)
      expect(cursors.hasImmediatePendingPulls()).toBe(true)
    })

    it('unblocks blockedOnKey if key is available when adding pending item', () => {
      blockOnMissingKey(ITEM, 'key-1')
      expect(cursors.getPendingPulls()).toEqual([])

      mockHasVaultKey.mockReturnValue(true)
      cursors.addPendingItem(ITEM)

      // The block was cleared, so the item stays pullable even if the key check changes
      mockHasVaultKey.mockReturnValue(false)
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 0, pageToken: undefined }])
    })

    it('keeps an item blocked when it is added before its key arrives', () => {
      blockOnMissingKey(ITEM, 'key-1')
      cursors.addPendingItem(ITEM)

      expect(cursors.getPendingPulls()).toEqual([])
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
    })
  })

  describe('retrying and immediate pulls evaluation', () => {
    it('reports items in retry backoff as retrying until they succeed', () => {
      expect(cursors.isAnyRetrying()).toBe(false)

      failParse(ITEM, 0)
      expect(cursors.isAnyRetrying()).toBe(true)

      record(ITEM, { highestCursor: 10 })
      expect(cursors.isAnyRetrying()).toBe(false)
    })

    it('reports items blocked on a missing key as retrying until the key arrives', () => {
      blockOnMissingKey(ITEM, 'missing-key')
      expect(cursors.isAnyRetrying()).toBe(true)

      mockHasVaultKey.mockReturnValue(true)
      expect(cursors.isAnyRetrying()).toBe(false)
    })

    it('reports pending items as immediate pulls', () => {
      cursors.addPendingItem(ITEM)
      expect(cursors.hasImmediatePendingPulls()).toBe(true)
    })

    it('does not report items in retry backoff as immediate pulls', () => {
      failParse(ITEM, 0)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
      // Still pending, so the next per-item poll retries it
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 0, pageToken: undefined }])
    })

    it('does not report items blocked on a missing key as immediate pulls until the key arrives', () => {
      blockOnMissingKey(ITEM, 'missing-key')
      expect(cursors.hasImmediatePendingPulls()).toBe(false)

      mockHasVaultKey.mockReturnValue(true)
      expect(cursors.hasImmediatePendingPulls()).toBe(true)
    })
  })

  describe('keyring unblocking', () => {
    it('unblocks blocked items and resets their retries when the key becomes available', () => {
      failParse(ITEM, 0)
      failParse(ITEM, 0)
      blockOnMissingKey(ITEM, 'key-2')

      expect(cursors.onKeyringUpdated()).toBe(false)
      expect(cursors.getPendingPulls()).toEqual([])

      mockHasVaultKey.mockReturnValue(true)
      expect(cursors.onKeyringUpdated()).toBe(true)
      expect(cursors.isAnyRetrying()).toBe(false)
      expect(cursors.hasImmediatePendingPulls()).toBe(true)

      // The block was cleared rather than just satisfied
      mockHasVaultKey.mockReturnValue(false)
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 0, pageToken: undefined }])
    })
  })

  describe('getPendingPulls and global cursors', () => {
    it('returns only pending and unblocked cursors', () => {
      pendingAt('item-1' as ItemId, 10)
      record('item-2' as ItemId, { highestCursor: 20 })
      pendingAt('item-3' as ItemId, 30)
      blockOnMissingKey('item-3' as ItemId, 'missing-k', 30)

      expect(cursors.getPendingPulls()).toEqual([{ itemId: 'item-1', cursor: 10, pageToken: undefined }])
    })

    it('returns global latest cursor', () => {
      pendingAt('item-1' as ItemId, 50)
      pendingAt('item-2' as ItemId, 120)
      record('item-3' as ItemId, { highestCursor: 80 })

      expect(cursors.getGlobalLatestCursor()).toBe(120)
    })
  })

  describe('import, export, and load', () => {
    it('exports and imports cursors', () => {
      pendingAt('item-1' as ItemId, 10)
      record('item-2' as ItemId, { highestCursor: 20 })

      const exported = cursors.exportCursors()
      expect(exported).toEqual([
        ['item-1', 10],
        ['item-2', 20],
      ])

      const cursors2 = new PullCursorState(keys)
      cursors2.importCursors(exported)
      expect(cursors2.exportCursors()).toEqual(exported)
    })

    it('does not move the global scan cursor when importing per-item cursors', () => {
      cursors.setGlobalCursor(100)
      cursors.importCursors([
        ['item-1' as ItemId, 500],
        ['item-2' as ItemId, 300],
      ])

      // Per-item cursors can run ahead of the scan, so they never raise it
      expect(cursors.getGlobalScanCursor()).toBe(100)
      expect(cursors.exportState().globalCursor).toBe(100)
      expect(cursors.getCursor('item-1' as ItemId)).toBe(500)
      expect(cursors.getGlobalLatestCursor()).toBe(500)
    })

    it('does not turn imported cursors into retries', () => {
      cursors.importCursors([
        ['item-1' as ItemId, 10],
        ['item-2' as ItemId, 20],
      ])

      expect(cursors.hasState('item-1' as ItemId)).toBe(false)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
      expect(cursors.getPendingPulls()).toEqual([])
      expect(cursors.exportState().retries).toBeUndefined()

      // Nothing becomes pending on the next startup either
      const restarted = new PullCursorState(keys)
      restarted.loadState(cursors.exportState())
      expect(restarted.getPendingPulls()).toEqual([])
    })

    it('keeps items that were waiting for a pull pending across an import', () => {
      record('item-pending' as ItemId, { highestCursor: 40, isNewItem: true, hasMore: true, pageToken: 'page-token' })
      pendingAt('item-untouched' as ItemId, 7)

      cursors.importCursors([['item-pending' as ItemId, 30]])

      expect(cursors.getPendingPulls()).toEqual(expect.arrayContaining([
        { itemId: 'item-pending', cursor: 30, pageToken: undefined },
        { itemId: 'item-untouched', cursor: 7, pageToken: undefined },
      ]))
      expect(cursors.getPendingPulls()).toHaveLength(2)
    })

    it('keeps the page token of a pending item whose imported cursor is unchanged', () => {
      record(ITEM, { highestCursor: 40, isNewItem: true, hasMore: true, pageToken: 'page-token' })

      cursors.importCursors([[ITEM, 40]])

      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 40, pageToken: 'page-token' }])
    })

    it('loads stored retries monotonically without regressing', () => {
      cursors.setGlobalCursor(500)
      pendingAt('item-1' as ItemId, 50)
      cursors.loadState({
        globalCursor: 100, // lower, should not regress
        retries: [
          ['item-1' as ItemId, 20], // lower, should not regress
          ['item-2' as ItemId, 30], // new, should be accepted
          ['item-3' as ItemId, -1], // invalid, should be ignored
        ],
      })

      expect(cursors.getGlobalScanCursor()).toBe(500)
      expect(cursors.getCursor('item-1' as ItemId)).toBe(50)
      expect(cursors.getCursor('item-2' as ItemId)).toBe(30)
      expect(cursors.hasState('item-3' as ItemId)).toBe(false)
    })

    it('drops page tokens without losing pending items', () => {
      record(ITEM, { highestCursor: 40, isNewItem: true, hasMore: true, pageToken: 'page-token' })

      cursors.clearPageTokens()

      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 40, pageToken: undefined }])
    })
  })

  describe('recordPullOutcome', () => {
    it('handles key failure outcome', () => {
      const outcome = blockOnMissingKey(ITEM, 'kver-2')

      expect(outcome).toEqual({ cursorUpdated: false, permanentlyFailed: false })
      expect(cursors.hasState(ITEM)).toBe(true)
      expect(cursors.getPendingPulls()).toEqual([])

      mockHasVaultKey.mockReturnValue(true)
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 0, pageToken: undefined }])
    })

    it('reports a cursor update for a new item even when a key failure kept it at 0', () => {
      const outcome = record(ITEM, { isNewItem: true, failure: { kind: 'keyMissing', kver: 'kver-2' } })

      expect(outcome.cursorUpdated).toBe(true) // isNewItem && highestCursor >= 0
      expect(outcome.permanentlyFailed).toBe(false)
    })

    it('keeps the cursor and retry count on a key failure', () => {
      pendingAt(ITEM, 10)
      failParse(ITEM, 10)
      failParse(ITEM, 10)

      const outcome = blockOnMissingKey(ITEM, 'new-key', 10)

      expect(outcome).toEqual({ cursorUpdated: false, permanentlyFailed: false })
      expect(cursors.getCursor(ITEM)).toBe(10)

      // Retries continue from where they were once the key arrives
      mockHasVaultKey.mockReturnValue(true)
      expect(cursors.isAnyRetrying()).toBe(true)
      expect(failParse(ITEM, 10).permanentlyFailed).toBe(false)
      expect(failParse(ITEM, 10).permanentlyFailed).toBe(false)
      expect(failParse(ITEM, 10, { failingCursor: 11 }).permanentlyFailed).toBe(true)
    })

    it('handles pagination success outcome (hasMore: true)', () => {
      const outcome = record(ITEM, { highestCursor: 100, isNewItem: true, hasMore: true, pageToken: 'item-1-page-token' })

      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 100, pageToken: 'item-1-page-token' }])
      expect(cursors.hasImmediatePendingPulls()).toBe(true)
      expect(outcome).toEqual({ cursorUpdated: true, permanentlyFailed: false })
    })

    it('clears retries and key blocks on a partial success', () => {
      pendingAt(ITEM, 50)
      failParse(ITEM, 50)
      blockOnMissingKey(ITEM, 'some-key', 50)

      // The key is still missing, but the page was readable after all
      record(ITEM, { highestCursor: 120, hasMore: true, pageToken: 'next-page' })

      expect(cursors.isAnyRetrying()).toBe(false)
      expect(cursors.hasImmediatePendingPulls()).toBe(true)
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 120, pageToken: 'next-page' }])
    })

    it('handles terminal success outcome (hasMore: false)', () => {
      record(ITEM, { highestCursor: 100, isNewItem: true, hasMore: true, pageToken: 'page-token' })

      const outcome = record(ITEM, { highestCursor: 150 })

      expect(cursors.hasState(ITEM)).toBe(false)
      expect(cursors.getPendingPulls()).toEqual([])
      expect(cursors.getCursor(ITEM)).toBe(150)
      expect(outcome).toEqual({ cursorUpdated: true, permanentlyFailed: false })
    })

    it('does not report a cursor update when a pull ends where it started', () => {
      cursors.importCursors([[ITEM, 30]])

      const outcome = record(ITEM, { highestCursor: 30 })

      expect(outcome.cursorUpdated).toBe(false)
      expect(cursors.getCursor(ITEM)).toBe(30)
    })

    it('stays pending in backoff on transient parse failures (attempts 1 to 4)', () => {
      for (let attempt = 1; attempt < PullCursorState.MAX_PULL_RETRIES; attempt += 1) {
        const outcome = failParse(ITEM, 0, { isNewItem: attempt === 1, failingCursor: 10 })

        expect(outcome.permanentlyFailed).toBe(false)
        expect(cursors.isAnyRetrying()).toBe(true)
        expect(cursors.hasImmediatePendingPulls()).toBe(false)
        expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 0, pageToken: undefined }])
      }
    })

    it('marks permanently failed on 5th consecutive parse failure and advances cursor past failing message', () => {
      failParseUntilLastRetry(ITEM, 0)

      const outcome = failParse(ITEM, 0, { failingCursor: 25 })

      expect(outcome).toEqual({ cursorUpdated: true, permanentlyFailed: true })
      expect(cursors.getCursor(ITEM)).toBe(25)
      // Still pending, so the next pull continues after the skipped message
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 25, pageToken: undefined }])
    })

    it('keeps the item pending after a give-up until a pull past the skipped message succeeds', () => {
      record(ITEM, { isNewItem: true, hasMore: true, pageToken: 'stale-token' })
      failParseUntilLastRetry(ITEM, 0)

      // The 5th failure skips the message at 25. Messages after it were never processed.
      failParse(ITEM, 0, { failingCursor: 25, nextCursor: 40 })
      expect(cursors.getPendingPulls()).toEqual([{ itemId: ITEM, cursor: 25, pageToken: undefined }])
      // One immediate poll continues the item; it is not a retry in backoff
      expect(cursors.hasImmediatePendingPulls()).toBe(true)
      expect(cursors.isAnyRetrying()).toBe(false)

      // The next pull from 25 processes the later messages and finishes the item
      record(ITEM, { highestCursor: 40 })
      expect(cursors.hasState(ITEM)).toBe(false)
      expect(cursors.getCursor(ITEM)).toBe(40)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
    })

    it('backs off again when the message after a skipped one also fails', () => {
      failParseUntilLastRetry(ITEM, 0)

      expect(failParse(ITEM, 0, { failingCursor: 25 }).permanentlyFailed).toBe(true)
      expect(failParse(ITEM, 25, { failingCursor: 30 }).permanentlyFailed).toBe(false)
      expect(cursors.getCursor(ITEM)).toBe(25)
      expect(cursors.isAnyRetrying()).toBe(true)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
    })

    it('drops the item on give-up when skipping cannot move the cursor forward', () => {
      pendingAt(ITEM, 30)
      failParseUntilLastRetry(ITEM, 30)

      const outcome = failParse(ITEM, 30)

      expect(outcome.permanentlyFailed).toBe(true)
      expect(cursors.hasState(ITEM)).toBe(false)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
      expect(cursors.isAnyRetrying()).toBe(false)
    })

    it('falls back to nextCursor if failingCursor is omitted on 5th failure', () => {
      failParseUntilLastRetry(ITEM, 0)

      const outcome = failParse(ITEM, 0, { nextCursor: 40 })

      expect(outcome.permanentlyFailed).toBe(true)
      expect(cursors.getCursor(ITEM)).toBe(40)
    })

    it('evicts healthy items from retryQueue on success while advancing globalCursor', () => {
      cursors.addPendingItem(ITEM)
      expect(cursors.hasState(ITEM)).toBe(true)

      const outcome = record(ITEM, { highestCursor: 500 })

      expect(outcome.cursorUpdated).toBe(true)
      expect(cursors.hasState(ITEM)).toBe(false)
      expect(cursors.hasImmediatePendingPulls()).toBe(false)
      expect(cursors.getGlobalLatestCursor()).toBe(500)
      expect(cursors.getPendingPulls()).toEqual([])
    })
  })

  describe('global cursor and state persistence', () => {
    it('sets global cursor monotonically', () => {
      cursors.setGlobalCursor(100)
      expect(cursors.getGlobalLatestCursor()).toBe(100)

      cursors.setGlobalCursor(50) // lower, should not regress
      expect(cursors.getGlobalLatestCursor()).toBe(100)

      cursors.setGlobalCursor(250)
      expect(cursors.getGlobalLatestCursor()).toBe(250)
    })

    it('exports and loads state with globalCursor and active retries', () => {
      cursors.setGlobalCursor(1000)
      record('item-retrying' as ItemId, { highestCursor: 400, isNewItem: true, hasMore: true, pageToken: 'page-token' })

      const state = cursors.exportState()
      expect(state.globalCursor).toBe(1000)
      expect(state.retries).toEqual([['item-retrying', 400]])

      const cursors2 = new PullCursorState(keys)
      cursors2.loadState(state)
      expect(cursors2.getGlobalLatestCursor()).toBe(1000)
      expect(cursors2.hasImmediatePendingPulls()).toBe(true)
      expect(cursors2.getPendingPulls()).toEqual([{ itemId: 'item-retrying', cursor: 400, pageToken: undefined }])
    })

    it('never raises the global scan cursor from per-item outcomes', () => {
      cursors.setGlobalCursor(100)
      record('item-ahead' as ItemId, { highestCursor: 500 })

      expect(cursors.getGlobalScanCursor()).toBe(100)
      expect(cursors.getGlobalLatestCursor()).toBe(500)
    })

    it('persists the global scan position rather than the highest per-item cursor', () => {
      cursors.setGlobalCursor(100)
      record('item-ahead' as ItemId, { highestCursor: 500, isNewItem: true, hasMore: true, pageToken: 'page-token' })

      const state = cursors.exportState()
      expect(state.globalCursor).toBe(100)
      expect(state.retries).toEqual([['item-ahead', 500]])

      const restored = new PullCursorState(keys)
      restored.loadState(state)
      expect(restored.getGlobalScanCursor()).toBe(100)
    })

    it('forgets everything on clear', () => {
      cursors.setGlobalCursor(100)
      pendingAt('item-1' as ItemId, 50)
      record('item-2' as ItemId, { highestCursor: 80 })

      cursors.clear()

      expect(cursors.getGlobalLatestCursor()).toBe(0)
      expect(cursors.exportCursors()).toEqual([])
      expect(cursors.getPendingPulls()).toEqual([])
    })
  })
})
