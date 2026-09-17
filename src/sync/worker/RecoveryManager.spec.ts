import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecoveryManager, RECOVERY_RETRY_COOLDOWN_MS } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import type { ItemId } from 'src/shared/schemas/items'

const mockReadManualRecoveryEntries = vi.fn()
const mockReadManualRecoveryCount = vi.fn()
const mockRemoveManualRecoveryEntryById = vi.fn()
const mockRemoveManualRecoveryEntryByItemId = vi.fn()
const mockUpsertManualRecoveryEntry = vi.fn()

vi.mock('../shared/manualRecoveryStore', () => ({
  readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
  readManualRecoveryCount: (...args: any[]) => mockReadManualRecoveryCount(...args),
  removeManualRecoveryEntryById: (...args: any[]) => mockRemoveManualRecoveryEntryById(...args),
  removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
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
    mockUpsertManualRecoveryEntry.mockResolvedValue(undefined)

    recoveryManager = new RecoveryManager({
      accountId: 'account-123',
      eventHub,
    })
  })

  describe('quarantine', () => {
    it('upserts recovery entry, sets cooldown, and emits recoveryItemsChanged', async () => {
      const mockEntries = [{ id: 'item-1', itemId: 'item-1', reason: 'bad decrypt', createdAt: 12345 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.quarantine('account-123', 'item-1' as ItemId, new Error('bad decrypt'))

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'bad decrypt',
      })
      expect(onEventMock).toHaveBeenCalledWith({
        type: 'recoveryItemsChanged',
        entries: mockEntries,
      })
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBeGreaterThan(Date.now())
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
    })

    it('works when accountId is provided in constructor and called without explicit accountId', async () => {
      await recoveryManager.quarantine('item-2' as ItemId, 'Snapshot failed')

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-2',
        reason: 'Snapshot failed',
      })
    })

    it('formats branch hints when failedBranches are provided', async () => {
      await recoveryManager.quarantine('account-123', 'item-3' as ItemId, new Error('fail'), {
        failedBranches: ['branch-a', 'branch-b'],
      })

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-3',
        reason: 'Corrupted branches: branch-a, branch-b',
      })
    })

    it('respects checkCooldown option when in cooldown', async () => {
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, Date.now() + 10000)

      await recoveryManager.quarantine('account-123', 'item-1' as ItemId, 'another fail', {
        checkCooldown: true,
      })

      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })

    it('respects in-flight protection', async () => {
      recoveryManager.setInFlight('item-1' as ItemId, true)

      await recoveryManager.quarantine('account-123', 'item-1' as ItemId, 'fail')

      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })

    it('clears in-flight flag even if upsert throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockUpsertManualRecoveryEntry.mockRejectedValueOnce(new Error('Storage failure'))

      await expect(
        recoveryManager.quarantine('account-123', 'item-fail' as ItemId, 'fail')
      ).rejects.toThrow('Storage failure')

      expect(recoveryManager.isInFlight('item-fail' as ItemId)).toBe(false)
      consoleSpy.mockRestore()
    })
  })

  describe('unquarantine', () => {
    it('removes entry, clears cooldown and in-flight, and emits recoveryItemsChanged', async () => {
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, Date.now() + 50000)
      recoveryManager.setInFlight('item-1' as ItemId, true)
      mockReadManualRecoveryEntries.mockResolvedValue([])

      await recoveryManager.unquarantine('account-123', 'item-1' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-1')
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      expect(onEventMock).toHaveBeenCalledWith({
        type: 'recoveryItemsChanged',
        entries: [],
      })
    })

    it('works when called with single itemId argument using constructor accountId', async () => {
      await recoveryManager.unquarantine('item-2' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-2')
    })
  })

  describe('unquarantineBatch', () => {
    it('clears cooldown and in-flight without DB calls when manual recovery count is 0', async () => {
      recoveryManager.setRecoveryCooldown('item-1' as ItemId, Date.now() + 50000)
      recoveryManager.setInFlight('item-1' as ItemId, true)
      mockReadManualRecoveryCount.mockResolvedValue(0)

      await recoveryManager.unquarantineBatch('account-123', ['item-1' as ItemId])

      expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      expect(onEventMock).not.toHaveBeenCalled()
    })

    it('removes all items and emits event once when count changed', async () => {
      mockReadManualRecoveryCount
        .mockResolvedValueOnce(2) // previous count
        .mockResolvedValueOnce(0) // next count

      await recoveryManager.unquarantineBatch('account-123', ['item-1' as ItemId, 'item-2' as ItemId])

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-1')
      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-2')
      expect(onEventMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('dismissEntry', () => {
    it('removes entry by id and emits event', async () => {
      await recoveryManager.dismissEntry('account-123', 'entry-456')

      expect(mockRemoveManualRecoveryEntryById).toHaveBeenCalledWith('account-123', 'entry-456')
      expect(onEventMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('listRecoveryItems', () => {
    it('returns entries from manual recovery store', async () => {
      const mockEntries = [{ id: 'item-1', itemId: 'item-1', reason: 'err', createdAt: 1 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      const result = await recoveryManager.listRecoveryItems('account-123')
      expect(result).toBe(mockEntries)
    })

    it('returns empty array if accountId is missing', async () => {
      recoveryManager.setAccountId(null)
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

      recoveryManager.reset()

      expect(recoveryManager.isInFlight('item-1' as ItemId)).toBe(false)
      expect(recoveryManager.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
    })
  })

  describe('reportDecryptionFailure and attemptAutoRecovery', () => {
    it('creates manual recovery entry and emits recoveryItemsChanged', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockEntries = [{ id: 'entry-1', itemId: 'item-1', reason: 'fail', createdAt: 1 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, new Error('bad decrypt'))

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'Automated recovery is unavailable for this revision',
      })
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
      consoleSpy.mockRestore()
    })

    it('includes failed branches hint when available', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await recoveryManager.reportDecryptionFailure(
        'item-1' as ItemId,
        new Error('bad decrypt'),
        ['branch-A', 'branch-B']
      )

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'Corrupted branches: branch-A, branch-B',
      })
      consoleSpy.mockRestore()
    })

    it('suppresses duplicate recovery triggers while in-flight or on cooldown', async () => {
      vi.useFakeTimers()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, new Error('fail 1'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Immediate second call should be blocked by cooldown
      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, new Error('fail 2'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Advance past 60s cooldown
      vi.advanceTimersByTime(61 * 1000)

      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, new Error('fail 3'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(2)

      consoleSpy.mockRestore()
      vi.useRealTimers()
    })

    it('does nothing if accountId or itemId is not set', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await recoveryManager.reportDecryptionFailure('' as ItemId, new Error('fail'))
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()

      recoveryManager.setAccountId(null)
      await recoveryManager.reportDecryptionFailure('item-1' as ItemId, new Error('fail'))
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
