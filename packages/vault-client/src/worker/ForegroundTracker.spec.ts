import { ForegroundTracker } from './ForegroundTracker'
import { createFakeRealtimeBus, type FakeRealtimeBus } from './__test__/testUtils'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

describe('ForegroundTracker', () => {
  let fakeBus: FakeRealtimeBus
  let onPeerReturned: ReturnType<typeof vi.fn<() => void>>
  let tracker: ForegroundTracker

  function createTracker(isVisible: boolean): ForegroundTracker {
    return new ForegroundTracker({ bus: fakeBus.bus, isVisible, onPeerReturned })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    fakeBus = createFakeRealtimeBus()
    onPeerReturned = vi.fn<() => void>()
  })

  afterEach(() => {
    tracker?.stop()
    vi.useRealTimers()
  })

  it('announces a visible tab at start and then pings while it stays visible', () => {
    tracker = createTracker(true)
    tracker.start()
    expect(fakeBus.publishTabVisibility).toHaveBeenCalledTimes(1)
    expect(fakeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, returned: true }))

    vi.advanceTimersByTime(SYNC_TIMEOUTS.foregroundPingInterval)
    expect(fakeBus.publishTabVisibility).toHaveBeenCalledTimes(2)
    expect(fakeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, returned: false }))
  })

  it('says nothing for a hidden tab until it becomes visible, and stops pinging once hidden', () => {
    tracker = createTracker(false)
    tracker.start()
    vi.advanceTimersByTime(SYNC_TIMEOUTS.foregroundPingInterval * 2)
    expect(fakeBus.publishTabVisibility).not.toHaveBeenCalled()
    expect(tracker.isAnyVisible).toBe(false)

    tracker.setVisible(true, true)
    expect(tracker.isAnyVisible).toBe(true)
    expect(fakeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, returned: true }))

    tracker.setVisible(false)
    expect(fakeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    const published = fakeBus.publishTabVisibility.mock.calls.length
    vi.advanceTimersByTime(SYNC_TIMEOUTS.foregroundPingInterval * 2)
    expect(fakeBus.publishTabVisibility).toHaveBeenCalledTimes(published)
  })

  it('announces focus on a tab that was already visible', () => {
    tracker = createTracker(true)
    tracker.start()
    tracker.setVisible(true)
    expect(fakeBus.publishTabVisibility).toHaveBeenCalledTimes(1)

    tracker.setVisible(true, true)
    expect(fakeBus.publishTabVisibility).toHaveBeenCalledTimes(2)
  })

  it('counts a visible peer until it reports hidden', () => {
    tracker = createTracker(false)
    tracker.start()

    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: true, returned: false })
    expect(tracker.isAnyVisible).toBe(true)

    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: false, returned: false })
    expect(tracker.isAnyVisible).toBe(false)
  })

  it('forgets a peer that stops pinging', () => {
    tracker = createTracker(false)
    tracker.start()

    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: true, returned: false })
    vi.advanceTimersByTime(SYNC_TIMEOUTS.foregroundPingInterval * 2)
    expect(tracker.isAnyVisible).toBe(true)

    vi.advanceTimersByTime(SYNC_TIMEOUTS.foregroundPingInterval)
    expect(tracker.isAnyVisible).toBe(false)
  })

  it('reports a peer that returns or that it did not know was visible, but not its regular pings', () => {
    tracker = createTracker(false)
    tracker.start()

    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: true, returned: false })
    expect(onPeerReturned).toHaveBeenCalledTimes(1)

    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: true, returned: false })
    expect(onPeerReturned).toHaveBeenCalledTimes(1)

    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: true, returned: true })
    expect(onPeerReturned).toHaveBeenCalledTimes(2)
  })

  it('tells the other tabs it is hidden when it stops, and stops listening', () => {
    tracker = createTracker(true)
    tracker.start()
    tracker.stop()

    expect(fakeBus.publishTabVisibility).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }))
    fakeBus.receiveTabVisibility({ tabId: 'peer', visible: true, returned: true })
    expect(onPeerReturned).not.toHaveBeenCalled()

    const published = fakeBus.publishTabVisibility.mock.calls.length
    vi.advanceTimersByTime(SYNC_TIMEOUTS.foregroundPingInterval * 2)
    expect(fakeBus.publishTabVisibility).toHaveBeenCalledTimes(published)
  })
})
