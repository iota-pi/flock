import { LeaderElection } from './LeaderElection'

describe('LeaderElection', () => {
  let originalNavigator: any

  beforeEach(() => {
    originalNavigator = global.navigator
  })

  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    })
  })

  it('falls back to granting leadership when navigator.locks is undefined', async () => {
    Object.defineProperty(global, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
    })

    const onLeaderGranted = vi.fn()
    const onLeaderRevoked = vi.fn()
    const election = new LeaderElection('acc-1', { onLeaderGranted, onLeaderRevoked })

    await election.acquire()

    expect(onLeaderGranted).toHaveBeenCalledTimes(1)
    expect(onLeaderRevoked).not.toHaveBeenCalled()
  })

  it('grants leadership when lock is acquired and revokes on release', async () => {
    const requestMock = vi.fn().mockImplementation((name, options, callback) => {
      return callback()
    })

    Object.defineProperty(global, 'navigator', {
      value: {
        locks: {
          request: requestMock,
        },
      },
      writable: true,
      configurable: true,
    })

    const onLeaderGranted = vi.fn()
    const onLeaderRevoked = vi.fn()
    const election = new LeaderElection('acc-1', { onLeaderGranted, onLeaderRevoked })

    await election.acquire()

    expect(requestMock).toHaveBeenCalledWith(
      'flock-sync-leader-acc-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.any(Function)
    )
    expect(onLeaderGranted).toHaveBeenCalledTimes(1)

    election.release()
    expect(onLeaderRevoked).toHaveBeenCalledTimes(1)
  })

  it('aborts pending lock request when release is called before lock is granted', async () => {
    let abortSignal: AbortSignal | null = null

    const requestMock = vi.fn().mockImplementation((name, options) => {
      abortSignal = options.signal
      return new Promise<void>((_, reject) => {
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            const abortError = new Error('The request was aborted')
            abortError.name = 'AbortError'
            reject(abortError)
          })
        }
      })
    })

    Object.defineProperty(global, 'navigator', {
      value: {
        locks: {
          request: requestMock,
        },
      },
      writable: true,
      configurable: true,
    })

    const onLeaderGranted = vi.fn()
    const onLeaderRevoked = vi.fn()
    const election = new LeaderElection('acc-1', { onLeaderGranted, onLeaderRevoked })

    await election.acquire()

    expect(requestMock).toHaveBeenCalled()
    expect(abortSignal).toBeDefined()
    expect((abortSignal as any)?.aborted).toBe(false)
    expect(onLeaderGranted).not.toHaveBeenCalled()

    // Call release while pending
    election.release()

    expect((abortSignal as any)?.aborted).toBe(true)
    expect(onLeaderRevoked).not.toHaveBeenCalled()

    // Ensure onLeaderGranted is never called even after catch handles AbortError
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(onLeaderGranted).not.toHaveBeenCalled()
  })

  it('falls back to granting leadership if lock request fails with non-abort error', async () => {
    const requestMock = vi.fn().mockRejectedValue(new Error('Lock system error'))

    Object.defineProperty(global, 'navigator', {
      value: {
        locks: {
          request: requestMock,
        },
      },
      writable: true,
      configurable: true,
    })

    const onLeaderGranted = vi.fn()
    const onLeaderRevoked = vi.fn()
    const election = new LeaderElection('acc-1', { onLeaderGranted, onLeaderRevoked })

    await election.acquire()

    // Wait for the catch block to run
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(onLeaderGranted).toHaveBeenCalledTimes(1)

    election.release()
    expect(onLeaderRevoked).toHaveBeenCalledTimes(1)
  })
})
