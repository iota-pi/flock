import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SnapshotPusher } from './SnapshotPusher'
import { SnapshotTracker } from './SnapshotTracker'
import { SnapshotBuilder } from './snapshotBuilder'
import { ItemId } from 'src/shared/schemas/items'
import { AuthError } from './SyncApiClient'

describe('SnapshotPusher', () => {
  let pusher: SnapshotPusher
  let mockTracker: any
  let mockBuilder: any
  let mockBroker: any
  let mockApiClient: any
  let mockRecoveryManager: any
  let mockEventHub: any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockTracker = {
      isOperational: true,
      dirtyCount: 1,
      getDirtyItemIds: vi.fn().mockReturnValue(['item-1' as ItemId]),
      getDirtyTick: vi.fn().mockReturnValue(1),
      recordSnapshotSuccess: vi.fn(),
      recordOversized: vi.fn(),
      removeDirtyItemIfTickMatches: vi.fn(),
      clearDebounceTimers: vi.fn(),
    }

    mockBuilder = {
      build: vi.fn().mockResolvedValue({
        type: 'success',
        snapshot: {
          itemId: 'item-1' as ItemId,
          snapshot: { cipher: 'abc', iv: '123', kver: '1' },
          snapshotCursor: 10,
          type: 'note',
          modified: 1000,
        },
        heads: ['head-1'],
      }),
      estimateSize: vi.fn().mockReturnValue(200),
    }

    mockBroker = {
      setSyncedHeads: vi.fn(),
      clearSnapshotOnlyItem: vi.fn(),
      unblockItem: vi.fn(),
    }

    mockApiClient = {
      hasAuthToken: vi.fn().mockResolvedValue(true),
      putSnapshots: vi.fn().mockResolvedValue({ success: true, persisted: 1 }),
    }

    mockRecoveryManager = {
      quarantine: vi.fn().mockResolvedValue(undefined),
      unquarantine: vi.fn().mockResolvedValue(undefined),
    }

    mockEventHub = {
      emit: vi.fn(),
    }

    pusher = new SnapshotPusher({
      accountId: 'test-acc',
      tracker: mockTracker as unknown as SnapshotTracker,
      builder: mockBuilder as unknown as SnapshotBuilder,
      broker: mockBroker,
      apiClient: mockApiClient,
      recoveryManager: mockRecoveryManager,
      eventHub: mockEventHub,
      maxPayloadBytes: 1000,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes snapshots successfully and notifies tracker and broker', async () => {
    const result = await pusher.pushSnapshots()

    expect(result).toEqual({ persisted: 1, total: 1 })
    expect(mockApiClient.putSnapshots).toHaveBeenCalledTimes(1)
    expect(mockTracker.recordSnapshotSuccess).toHaveBeenCalledWith('item-1', 1000, 1)
    expect(mockBroker.setSyncedHeads).toHaveBeenCalledWith('item-1', ['head-1'])
    expect(mockBroker.clearSnapshotOnlyItem).toHaveBeenCalledWith('item-1')
    expect(mockBroker.unblockItem).toHaveBeenCalledWith('item-1')
    expect(mockRecoveryManager.unquarantine).toHaveBeenCalledWith('item-1')
  })

  it('handles oversized item by quarantining and emitting quotaExceeded', async () => {
    mockBuilder.estimateSize.mockReturnValue(5000) // Exceeds maxPayloadBytes = 1000

    const result = await pusher.pushSnapshots()

    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(pusher.oversizedItems.has('item-1' as ItemId)).toBe(true)
    expect(mockTracker.recordOversized).toHaveBeenCalledWith('item-1', 1000)
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'quotaExceeded' }),
    )
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      expect.stringContaining('exceeds 350 KB limit'),
    )
  })

  it('quarantines item after 5 consecutive failures', async () => {
    mockBuilder.build.mockResolvedValue({
      type: 'error',
      reason: 'Failed to encrypt',
    })

    // 4 failures
    for (let i = 0; i < 4; i++) {
      await pusher.pushSnapshots()
      expect(pusher.consecutiveFailures.get('item-1' as ItemId)).toBe(i + 1)
      expect(mockRecoveryManager.quarantine).not.toHaveBeenCalled()
    }

    // 5th failure triggers quarantine
    await pusher.pushSnapshots()

    expect(pusher.consecutiveFailures.has('item-1' as ItemId)).toBe(false)
    expect(mockTracker.removeDirtyItemIfTickMatches).toHaveBeenCalledWith('item-1', 1)
    expect(mockEventHub.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshotFailed', itemId: 'item-1' }),
    )
    expect(mockRecoveryManager.quarantine).toHaveBeenCalledWith(
      'item-1',
      expect.stringContaining('Snapshot failure'),
    )
  })

  it('schedules retry on push failure when items remain dirty', async () => {
    mockApiClient.putSnapshots.mockResolvedValue({ success: false, persisted: 0 })

    await pusher.pushSnapshots()

    expect(pusher.retryAttempt).toBe(1)
    expect(pusher.retryTimeoutId).not.toBeNull()

    // Cancel retry
    pusher.cancelRetry()
    expect(pusher.retryTimeoutId).toBeNull()
  })

  it('handles push gracefully if no auth token is present (AuthError)', async () => {
    mockApiClient.putSnapshots.mockRejectedValue(new AuthError('No active session token available'))

    const result = await pusher.pushSnapshots()
    expect(result).toEqual({ persisted: 0, total: 0 })
    expect(mockApiClient.putSnapshots).toHaveBeenCalled()
  })
})
