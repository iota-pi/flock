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
})
