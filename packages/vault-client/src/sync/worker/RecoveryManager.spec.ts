import { INBOUND_MESSAGE_RESOLVABLE_KINDS, RecoveryManager } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import type { ItemId } from '@vault/shared'

const mockReadManualRecoveryEntries = vi.fn()
const mockReadManualRecoveryCount = vi.fn()
const mockRemoveManualRecoveryEntryById = vi.fn()
const mockRemoveManualRecoveryEntryByItemId = vi.fn()
const mockRemoveManualRecoveryEntryIfKind = vi.fn()
const mockUpsertManualRecoveryEntry = vi.fn()

vi.mock('../shared/manualRecoveryStore', () => ({
  readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
  readManualRecoveryCount: (...args: any[]) => mockReadManualRecoveryCount(...args),
  removeManualRecoveryEntryById: (...args: any[]) => mockRemoveManualRecoveryEntryById(...args),
  removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
  removeManualRecoveryEntryIfKind: (...args: any[]) => mockRemoveManualRecoveryEntryIfKind(...args),
  upsertManualRecoveryEntry: (...args: any[]) => mockUpsertManualRecoveryEntry(...args),
}))

describe('RecoveryManager', () => {
  let recoveryManager: RecoveryManager
  let eventHub: ClientEventHub
  let onEventMock: any

  beforeEach(() => {
    vi.clearAllMocks()

    eventHub = new ClientEventHub()
    onEventMock = vi.fn()
    eventHub.subscribe(onEventMock)

    mockReadManualRecoveryEntries.mockResolvedValue([])
    mockReadManualRecoveryCount.mockResolvedValue(0)
    mockRemoveManualRecoveryEntryById.mockResolvedValue(undefined)
    mockRemoveManualRecoveryEntryByItemId.mockResolvedValue(undefined)
    mockRemoveManualRecoveryEntryIfKind.mockResolvedValue(true)
    mockUpsertManualRecoveryEntry.mockResolvedValue(undefined)

    recoveryManager = new RecoveryManager({
      accountId: 'account-123',
      eventHub,
    })
  })

  describe('quarantine', () => {
    it('upserts recovery entry, sets cooldown, and emits recoveryItemsChanged', async () => {
      const mockEntries = [{ id: 'item-1', itemId: 'item-1', reason: 'bad decrypt', kind: 'pullDecryption', createdAt: 12345 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.quarantine('item-1' as ItemId, 'pushFailure', new Error('bad decrypt'))

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'bad decrypt',
        kind: 'pushFailure',
      })
      expect(onEventMock).toHaveBeenCalledWith({
        type: 'recoveryItemsChanged',
        entries: mockEntries,
      })
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBeGreaterThan(Date.now())
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
    })

    it('works when accountId is provided in constructor and called without explicit accountId', async () => {
      await recoveryManager.quarantine('item-2' as ItemId, 'pushFailure', 'Snapshot failed')

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-2',
        reason: 'Snapshot failed',
        kind: 'pushFailure',
      })
    })

    it('formats branch hints when failedBranches are provided', async () => {
      await recoveryManager.quarantine('item-3' as ItemId, 'pushFailure', new Error('fail'), {
        failedBranches: ['branch-a', 'branch-b'],
      })

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-3',
        reason: 'Corrupted branches: branch-a, branch-b',
        kind: 'pushFailure',
      })
    })

    it('respects checkCooldown option when in cooldown', async () => {
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, Date.now() + 10000)

      await recoveryManager.quarantine('item-1' as ItemId, 'pushFailure', 'another fail', {
        checkCooldown: true,
      })

      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })

    it('respects in-flight protection', async () => {
      recoveryManager.setInFlight('item-1' as ItemId, true)

      await recoveryManager.quarantine('item-1' as ItemId, 'pushFailure', 'fail')

      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })

    it('clears in-flight flag even if upsert throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockUpsertManualRecoveryEntry.mockRejectedValueOnce(new Error('Storage failure'))

      await expect(
        recoveryManager.quarantine('item-fail' as ItemId, 'pushFailure', 'fail')
      ).rejects.toThrow('Storage failure')

      expect(recoveryManager.isInFlight('item-fail' as ItemId)).toBe(false)
      consoleSpy.mockRestore()
    })

    it('no-ops if accountId is missing', async () => {
      recoveryManager = new RecoveryManager({ eventHub })
      await recoveryManager.quarantine('item-1' as ItemId, 'pushFailure', 'fail')
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })
  })

  describe('unquarantine', () => {
    it('removes entry, clears cooldown and in-flight, and emits recoveryItemsChanged', async () => {
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, Date.now() + 50000)
      recoveryManager.setInFlight('item-1' as ItemId, true)
      mockReadManualRecoveryEntries.mockResolvedValue([])

      await recoveryManager.unquarantine('item-1' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-1')
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      expect(onEventMock).toHaveBeenCalledWith({
        type: 'recoveryItemsChanged',
        entries: [],
      })
    })

    it('no-ops if accountId is missing', async () => {
      recoveryManager = new RecoveryManager({ eventHub })
      await recoveryManager.unquarantine('item-2' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
    })
  })

  describe('resolveQuarantines', () => {
    const kinds = INBOUND_MESSAGE_RESOLVABLE_KINDS

    it('does nothing when manual recovery count is 0', async () => {
      mockReadManualRecoveryCount.mockResolvedValue(0)

      await recoveryManager.resolveQuarantines(['item-1' as ItemId], kinds)

      expect(mockRemoveManualRecoveryEntryIfKind).not.toHaveBeenCalled()
      expect(onEventMock).not.toHaveBeenCalled()
    })

    it('removes once per unique id and emits once', async () => {
      mockReadManualRecoveryCount.mockResolvedValue(2)

      await recoveryManager.resolveQuarantines(['item-1', 'item-2', 'item-1'] as ItemId[], kinds)

      expect(mockRemoveManualRecoveryEntryIfKind).toHaveBeenCalledTimes(2)
      expect(mockRemoveManualRecoveryEntryIfKind).toHaveBeenCalledWith('account-123', 'item-1', kinds)
      expect(mockRemoveManualRecoveryEntryIfKind).toHaveBeenCalledWith('account-123', 'item-2', kinds)
      expect(onEventMock).toHaveBeenCalledTimes(1)
    })

    it('clears cooldown and in-flight only for removed ids', async () => {
      mockReadManualRecoveryCount.mockResolvedValue(2)
      mockRemoveManualRecoveryEntryIfKind.mockImplementation(async (_acc: string, id: string) => id === 'item-1')
      for (const id of ['item-1', 'item-2'] as ItemId[]) {
        recoveryManager.setRecoveryCooldown(id, Date.now() + 50000)
        recoveryManager.setInFlight(id, true)
      }

      await recoveryManager.resolveQuarantines(['item-1', 'item-2'] as ItemId[], kinds)

      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      expect(recoveryManager.getRecoveryCooldownUntil('item-2' as ItemId)).toBeGreaterThan(0)
      expect(recoveryManager.isInFlight('item-2' as ItemId)).toBe(true)
    })

    it('does not emit when nothing was removed', async () => {
      mockReadManualRecoveryCount.mockResolvedValue(1)
      mockRemoveManualRecoveryEntryIfKind.mockResolvedValue(false)

      await recoveryManager.resolveQuarantines(['item-1' as ItemId], kinds)

      expect(onEventMock).not.toHaveBeenCalled()
    })

    it('no-ops if accountId is missing', async () => {
      recoveryManager = new RecoveryManager({ eventHub })
      await recoveryManager.resolveQuarantines(['item-1' as ItemId], kinds)

      expect(mockRemoveManualRecoveryEntryIfKind).not.toHaveBeenCalled()
    })
  })

  describe('dismissEntry', () => {
    it('removes entry by id and emits event', async () => {
      await recoveryManager.dismissEntry('entry-456')

      expect(mockRemoveManualRecoveryEntryById).toHaveBeenCalledWith('account-123', 'entry-456')
      expect(onEventMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('listRecoveryItems', () => {
    it('returns entries from manual recovery store', async () => {
      const mockEntries = [{ id: 'item-1', itemId: 'item-1', reason: 'err', kind: 'pullDecryption', createdAt: 1 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      const result = await recoveryManager.listRecoveryItems()
      expect(result).toBe(mockEntries)
      expect(mockReadManualRecoveryEntries).toHaveBeenCalledWith('account-123', undefined)
    })

    it('returns empty array if accountId is missing', async () => {
      recoveryManager = new RecoveryManager({ eventHub })
      const result = await recoveryManager.listRecoveryItems()
      expect(result).toEqual([])
    })
  })

  describe('in-flight and cooldown helpers', () => {
    it('manages in-flight state correctly', () => {
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      recoveryManager.setInFlight('item-1' as ItemId, true)
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(true)
      recoveryManager.setInFlight('item-1' as ItemId, false)
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
    })

    it('manages cooldown state correctly', () => {
      const future = Date.now() + 5000
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, future)
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(future)
      recoveryManager.clearRecoveryCooldown('item-1' as ItemId)
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
    })

    it('resets all state on reset()', () => {
      recoveryManager.setInFlight('item-1' as ItemId, true)
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, Date.now() + 5000)

      recoveryManager.resetRecoveryState()

      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
    })
  })

  describe('reportDecryptionFailure', () => {
    it('creates manual recovery entry and emits recoveryItemsChanged', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockEntries = [{ id: 'entry-1', itemId: 'item-1', reason: 'fail', kind: 'pullDecryption', createdAt: 1 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, 'pullDecryption', new Error('bad decrypt'))

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'Automated recovery is unavailable for this revision',
        kind: 'pullDecryption',
      })
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
      consoleSpy.mockRestore()
    })

    it('upserts with the snapshotDecryption kind when reported from manifest hydration', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, 'snapshotDecryption', new Error('bad'))

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', expect.objectContaining({
        itemId: 'item-1',
        kind: 'snapshotDecryption',
      }))
      consoleSpy.mockRestore()
    })

    it('includes failed branches hint when available', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await recoveryManager.reportDecryptionFailure(
        'item-1' as ItemId,
        'pullDecryption',
        new Error('bad decrypt'),
        ['branch-A', 'branch-B']
      )

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'Corrupted branches: branch-A, branch-B',
        kind: 'pullDecryption',
      })
      consoleSpy.mockRestore()
    })

    it('suppresses duplicate recovery triggers while in-flight or on cooldown', async () => {
      vi.useFakeTimers()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, 'pullDecryption', new Error('fail 1'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Immediate second call should be blocked by cooldown
      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, 'pullDecryption', new Error('fail 2'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Advance past 60s cooldown
      vi.advanceTimersByTime(61 * 1000)

      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, 'pullDecryption', new Error('fail 3'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(2)

      consoleSpy.mockRestore()
      vi.useRealTimers()
    })

    it('does nothing if accountId or itemId is not set', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await recoveryManager.reportDecryptionFailure('' as ItemId, 'pullDecryption', new Error('fail'))
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()

      recoveryManager = new RecoveryManager({ eventHub })
      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, 'pullDecryption', new Error('fail'))
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
