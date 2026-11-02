import { RetryTimer } from './RetryTimer'

describe('RetryTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the callback after the delay and is no longer pending', () => {
    const timer = new RetryTimer()
    const callback = vi.fn()

    timer.schedule(100, callback)
    expect(timer.isPending).toBe(true)

    vi.advanceTimersByTime(99)
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(timer.isPending).toBe(false)
  })

  it('replaces a pending retry when scheduled again', () => {
    const timer = new RetryTimer()
    const first = vi.fn()
    const second = vi.fn()

    timer.schedule(100, first)
    timer.schedule(200, second)

    vi.advanceTimersByTime(1000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending retry', () => {
    const timer = new RetryTimer()
    const callback = vi.fn()

    timer.schedule(100, callback)
    timer.cancel()

    expect(timer.isPending).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('lets the callback schedule the next retry', () => {
    const timer = new RetryTimer()
    const callback = vi.fn(() => {
      if (callback.mock.calls.length === 1) {
        timer.schedule(100, callback)
      }
    })

    timer.schedule(100, callback)
    vi.advanceTimersByTime(100)
    expect(timer.isPending).toBe(true)

    vi.advanceTimersByTime(100)
    expect(callback).toHaveBeenCalledTimes(2)
    expect(timer.isPending).toBe(false)
  })

  it('treats a negative delay as zero', () => {
    const timer = new RetryTimer()
    const callback = vi.fn()

    timer.schedule(-50, callback)
    vi.advanceTimersByTime(0)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
