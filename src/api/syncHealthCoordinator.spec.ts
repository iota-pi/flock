import { initializeSyncHealthWatchers, teardownSyncHealthWatchers, resetSyncHealthState } from './syncHealthCoordinator'
import * as realtimeBus from '../sync/client/realtimeBus'
import { useAppStore } from '../state/store'

vi.mock('../sync/shared/manualRecoveryStore', () => ({
  readManualRecoveryCount: vi.fn().mockResolvedValue(0),
  removeManualRecoveryEntryByItemId: vi.fn().mockResolvedValue(undefined),
  upsertManualRecoveryEntry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@sentry/react', () => ({
  captureMessage: vi.fn(),
}))

describe('syncHealthCoordinator watchers lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSyncHealthState()
    useAppStore.setState({ account: 'test-account' })
  })

  afterEach(() => {
    teardownSyncHealthWatchers()
  })

  it('subscribes to realtime bus and returns teardown function', () => {
    const unsubMock = vi.fn()
    const subscribeSpy = vi.spyOn(realtimeBus, 'subscribeRealtimeBusSyncPing').mockReturnValue(unsubMock)

    const teardown = initializeSyncHealthWatchers()
    expect(subscribeSpy).toHaveBeenCalledTimes(1)

    // Second call is a no-op / idempotent
    initializeSyncHealthWatchers()
    expect(subscribeSpy).toHaveBeenCalledTimes(1)

    teardown()
    expect(unsubMock).toHaveBeenCalledTimes(1)
  })

  it('teardownSyncHealthWatchers clears the active subscription', () => {
    const unsubMock = vi.fn()
    vi.spyOn(realtimeBus, 'subscribeRealtimeBusSyncPing').mockReturnValue(unsubMock)

    initializeSyncHealthWatchers()
    teardownSyncHealthWatchers()

    expect(unsubMock).toHaveBeenCalledTimes(1)

    // Re-initialization after teardown subscribes again
    initializeSyncHealthWatchers()
    expect(realtimeBus.subscribeRealtimeBusSyncPing).toHaveBeenCalledTimes(2)
  })

  it('respects cooldown and lazily expires it', async () => {
    vi.useFakeTimers()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { reportDecryptionFailure } = await import('./syncHealthCoordinator')
    const { upsertManualRecoveryEntry } = await import('../sync/shared/manualRecoveryStore')

    reportDecryptionFailure('test-account', { itemId: 'item-1', error: new Error('fail') })
    await Promise.resolve()
    await Promise.resolve()

    expect(upsertManualRecoveryEntry).toHaveBeenCalledWith('test-account', {
      itemId: 'item-1',
      reason: 'Automated recovery is unavailable for this revision',
    })

    // Second failure within cooldown window should not trigger upsertManualRecoveryEntry again
    reportDecryptionFailure('test-account', { itemId: 'item-1', error: new Error('fail') })
    await Promise.resolve()
    await Promise.resolve()
    expect(upsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

    // Advance time past cooldown (60 seconds)
    vi.advanceTimersByTime(61 * 1000)

    // Now it should trigger again and lazily clear expired cooldown
    reportDecryptionFailure('test-account', { itemId: 'item-1', error: new Error('fail') })
    await Promise.resolve()
    await Promise.resolve()
    expect(upsertManualRecoveryEntry).toHaveBeenCalledTimes(2)

    consoleSpy.mockRestore()
    vi.useRealTimers()
  })
})
