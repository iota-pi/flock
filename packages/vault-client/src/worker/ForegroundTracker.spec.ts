import { ForegroundTracker } from './ForegroundTracker'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

describe('ForegroundTracker', () => {
  let onActivity: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    onActivity = vi.fn<() => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks the tab\'s visibility', () => {
    const tracker = new ForegroundTracker({ isVisible: false, onActivity })
    expect(tracker.isVisible).toBe(false)

    tracker.setVisible(true)
    expect(tracker.isVisible).toBe(true)

    tracker.setVisible(false)
    expect(tracker.isVisible).toBe(false)
  })

  it('is active for the activity window after activity in a visible tab', () => {
    const tracker = new ForegroundTracker({ isVisible: true, onActivity })
    expect(tracker.isActive).toBe(false)

    tracker.noteActivity()
    expect(tracker.isActive).toBe(true)
    expect(onActivity).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(SYNC_TIMEOUTS.activityWindow - 1)
    expect(tracker.isActive).toBe(true)
    vi.advanceTimersByTime(1)
    expect(tracker.isActive).toBe(false)
  })

  it('is never active while hidden, but remembers the activity for when it is visible again', () => {
    const tracker = new ForegroundTracker({ isVisible: false, onActivity })

    tracker.noteActivity()
    expect(onActivity).toHaveBeenCalledTimes(1)
    expect(tracker.isActive).toBe(false)

    tracker.setVisible(true)
    expect(tracker.isActive).toBe(true)
  })
})
