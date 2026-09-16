import { LeaderElection } from './LeaderElection'

class MockBroadcastChannel {
  name: string
  onmessage: ((ev: MessageEvent) => any) | null = null
  static channels = new Set<MockBroadcastChannel>()

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.channels.add(this)
  }

  postMessage(data: any): void {
    for (const ch of Array.from(MockBroadcastChannel.channels)) {
      if (ch !== this && ch.name === this.name && ch.onmessage) {
        ch.onmessage({ data } as MessageEvent)
      }
    }
  }

  close(): void {
    MockBroadcastChannel.channels.delete(this)
  }
}

describe('LeaderElection', () => {
  let originalNavigator: any

  beforeEach(() => {
    originalNavigator = global.navigator
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    MockBroadcastChannel.channels.clear()
  })

  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
      configurable: true,
    })
    MockBroadcastChannel.channels.clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
    expect(election.leader).toBe(true)
    expect(election.fallback).toBe(true)
    election.release()
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
    expect(election.leader).toBe(true)
    expect(election.fallback).toBe(false)

    election.release()
    expect(onLeaderRevoked).toHaveBeenCalledTimes(1)
    expect(election.leader).toBe(false)
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

  it('does not immediately grant leadership on initial non-abort error and waits for retry', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const requestMock = vi.fn().mockRejectedValue(new Error('Transient lock error'))

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
    const election = new LeaderElection(
      'acc-1',
      { onLeaderGranted, onLeaderRevoked },
      { maxLockRetries: 3, retryDelayMs: 200 }
    )

    await election.acquire()
    await new Promise(resolve => setTimeout(resolve, 20))

    // Initial failure should not grant leadership
    expect(onLeaderGranted).not.toHaveBeenCalled()
    expect(election.leader).toBe(false)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LeaderElection] Failed to acquire lock (attempt 1/3)'),
      expect.any(Error)
    )

    election.release()
    consoleErrorSpy.mockRestore()
  })

  it('acquires leadership successfully on retry after transient failure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const requestMock = vi.fn().mockImplementation((name, options, callback) => {
      attempts++
      if (attempts === 1) {
        return Promise.reject(new Error('Transient error on attempt 1'))
      }
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
    const election = new LeaderElection(
      'acc-1',
      { onLeaderGranted, onLeaderRevoked },
      { maxLockRetries: 3, retryDelayMs: 20 }
    )

    await election.acquire()

    // Wait for attempt 1 failure and retry delay
    await vi.waitFor(
      () => {
        expect(onLeaderGranted).toHaveBeenCalledTimes(1)
      },
      { timeout: 500 }
    )

    expect(attempts).toBe(2)
    expect(election.leader).toBe(true)
    expect(election.fallback).toBe(false)

    election.release()
    expect(onLeaderRevoked).toHaveBeenCalledTimes(1)
    consoleErrorSpy.mockRestore()
  })

  it('falls back to granting leadership after exceeding maxLockRetries', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const requestMock = vi.fn().mockRejectedValue(new Error('Permanent lock failure'))

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
    const election = new LeaderElection(
      'acc-1',
      { onLeaderGranted, onLeaderRevoked },
      { maxLockRetries: 3, retryDelayMs: 15 }
    )

    await election.acquire()

    // Wait for all retries to complete and fallback to trigger
    await vi.waitFor(
      () => {
        expect(onLeaderGranted).toHaveBeenCalledTimes(1)
      },
      { timeout: 500 }
    )

    expect(election.leader).toBe(true)
    expect(election.fallback).toBe(true)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LeaderElection] Web Locks permanently failed after 3 attempts'),
      expect.any(Error)
    )

    election.release()
    expect(onLeaderRevoked).toHaveBeenCalledTimes(1)
    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('revokes leadership if lock callback rejects unexpectedly', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectCallbackPromise: (err: Error) => void

    let callCount = 0
    const requestMock = vi.fn().mockImplementation((name, options, callback) => {
      callCount++
      if (callCount === 1) {
        callback()
        return new Promise<void>((_, reject) => {
          rejectCallbackPromise = reject
        })
      }
      return new Promise<void>(() => {})
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
    const election = new LeaderElection(
      'acc-1',
      { onLeaderGranted, onLeaderRevoked },
      { maxLockRetries: 3, retryDelayMs: 1000 }
    )

    await election.acquire()
    expect(onLeaderGranted).toHaveBeenCalledTimes(1)
    expect(election.leader).toBe(true)

    // Unexpected failure while holding lock
    rejectCallbackPromise!(new Error('Lock terminated unexpectedly'))
    await vi.waitFor(() => {
      expect(onLeaderRevoked).toHaveBeenCalledTimes(1)
    })

    expect(election.leader).toBe(false)

    election.release()
    consoleErrorSpy.mockRestore()
  })

  it('cancels scheduled retry when release is called', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let attempts = 0
    const requestMock = vi.fn().mockImplementation(() => {
      attempts++
      return Promise.reject(new Error('Lock error'))
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
    const election = new LeaderElection(
      'acc-1',
      { onLeaderGranted, onLeaderRevoked },
      { maxLockRetries: 3, retryDelayMs: 50 }
    )

    await election.acquire()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempts).toBe(1)

    // Release before retry fires
    election.release()

    // Wait past retry delay
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(attempts).toBe(1)
    expect(onLeaderGranted).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  it('detects multiple leaders via presence channel and restores sole leader when other releases', async () => {
    const onMultipleLeadersDetected1 = vi.fn()
    const onSoleLeaderRestored1 = vi.fn()
    const onMultipleLeadersDetected2 = vi.fn()
    const onSoleLeaderRestored2 = vi.fn()

    // Two fallback elections simulating two tabs in an environment without web locks
    const election1 = new LeaderElection(
      'acc-1',
      {
        onLeaderGranted: vi.fn(),
        onLeaderRevoked: vi.fn(),
        onMultipleLeadersDetected: onMultipleLeadersDetected1,
        onSoleLeaderRestored: onSoleLeaderRestored1,
      },
      { presenceHeartbeatIntervalMs: 50, presenceTimeoutMs: 150 }
    )

    const election2 = new LeaderElection(
      'acc-1',
      {
        onLeaderGranted: vi.fn(),
        onLeaderRevoked: vi.fn(),
        onMultipleLeadersDetected: onMultipleLeadersDetected2,
        onSoleLeaderRestored: onSoleLeaderRestored2,
      },
      { presenceHeartbeatIntervalMs: 50, presenceTimeoutMs: 150 }
    )

    // Both tabs acquire leadership (navigator.locks is undefined)
    await election1.acquire()
    await election2.acquire()

    // Both should detect the other leader via presence heartbeat
    await vi.waitFor(() => {
      expect(onMultipleLeadersDetected1).toHaveBeenCalled()
      expect(onMultipleLeadersDetected2).toHaveBeenCalled()
    })

    expect(election1.activeOtherLeaderCount).toBe(1)
    expect(election2.activeOtherLeaderCount).toBe(1)

    // Tab 2 releases
    election2.release()

    // Tab 1 should see release message and restore sole leader status
    await vi.waitFor(() => {
      expect(onSoleLeaderRestored1).toHaveBeenCalled()
    })

    expect(election1.activeOtherLeaderCount).toBe(0)

    election1.release()
  })

  it('restores sole leader when other leader heartbeats time out', async () => {
    const onMultipleLeadersDetected = vi.fn()
    const onSoleLeaderRestored = vi.fn()

    const election1 = new LeaderElection(
      'acc-1',
      {
        onLeaderGranted: vi.fn(),
        onLeaderRevoked: vi.fn(),
        onMultipleLeadersDetected,
        onSoleLeaderRestored,
      },
      { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 80 }
    )

    await election1.acquire()

    // Simulate another tab's heartbeat arriving from an external source
    const peerPresenceChannel = new MockBroadcastChannel('flock-leader-presence-acc-1')
    peerPresenceChannel.postMessage({
      type: 'heartbeat',
      leaderId: 'other-leader-abc',
      isFallback: true,
    })

    await vi.waitFor(() => {
      expect(onMultipleLeadersDetected).toHaveBeenCalled()
    })
    expect(election1.activeOtherLeaderCount).toBe(1)

    // Wait for presenceTimeoutMs to expire without any more heartbeats from other-leader-abc
    await vi.waitFor(
      () => {
        expect(onSoleLeaderRestored).toHaveBeenCalled()
      },
      { timeout: 300 }
    )

    expect(election1.activeOtherLeaderCount).toBe(0)

    election1.release()
    peerPresenceChannel.close()
  })

  describe('Leader Conflict & Claim Leadership (Approach B)', () => {
    it('newer tab yields leadership and notifies onLeaderConflict(true) when two tabs enter fallback mode', async () => {
      const onConflict1 = vi.fn()
      const onConflict2 = vi.fn()
      const onLeaderRevoked2 = vi.fn()

      const election1 = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: onConflict1,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      // Tab 1 acquires at T=100
      vi.setSystemTime(100)
      await election1.acquire()
      expect(election1.leader).toBe(true)
      expect(election1.yielded).toBe(false)

      const election2 = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: onLeaderRevoked2,
          onLeaderConflict: onConflict2,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      // Tab 2 acquires later at T=200
      vi.setSystemTime(200)
      await election2.acquire()

      // Tab 2 should detect Tab 1 is older and yield leadership
      await vi.waitFor(() => {
        expect(onConflict2).toHaveBeenCalledWith(true)
        expect(onLeaderRevoked2).toHaveBeenCalled()
        expect(election2.yielded).toBe(true)
        expect(election2.leader).toBe(false)
      })

      // Tab 1 remains active leader without conflict
      expect(election1.leader).toBe(true)
      expect(election1.yielded).toBe(false)
      expect(onConflict1).not.toHaveBeenCalledWith(true)

      election1.release()
      election2.release()
      vi.useRealTimers()
    })

    it('allows yielded tab to reclaim leadership via claimLeadership, causing older tab to yield', async () => {
      const onConflict1 = vi.fn()
      const onConflict2 = vi.fn()
      const onLeaderGranted2 = vi.fn()

      const election1 = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: onConflict1,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      vi.setSystemTime(100)
      await election1.acquire()

      const election2 = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: onLeaderGranted2,
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: onConflict2,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      vi.setSystemTime(200)
      await election2.acquire()

      await vi.waitFor(() => {
        expect(election2.yielded).toBe(true)
      })

      // Tab 2 claims leadership
      onLeaderGranted2.mockClear()
      election2.claimLeadership()

      // Tab 2 becomes leader and clears conflict
      expect(election2.leader).toBe(true)
      expect(election2.yielded).toBe(false)
      expect(onLeaderGranted2).toHaveBeenCalled()
      expect(onConflict2).toHaveBeenCalledWith(false)

      // Tab 1 receives claim and yields
      await vi.waitFor(() => {
        expect(election1.leader).toBe(false)
        expect(election1.yielded).toBe(true)
        expect(onConflict1).toHaveBeenCalledWith(true)
      })

      election1.release()
      election2.release()
      vi.useRealTimers()
    })

    it('auto-recovers leadership on yielded tab when active leader tab releases', async () => {
      const onConflict2 = vi.fn()
      const onLeaderGranted2 = vi.fn()

      const election1 = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: vi.fn(),
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      vi.setSystemTime(100)
      await election1.acquire()

      const election2 = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: onLeaderGranted2,
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: onConflict2,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      vi.setSystemTime(200)
      await election2.acquire()

      await vi.waitFor(() => {
        expect(election2.yielded).toBe(true)
      })

      onLeaderGranted2.mockClear()
      onConflict2.mockClear()

      // Tab 1 closes / releases
      election1.release()

      // Tab 2 automatically un-yields and reclaims leadership
      await vi.waitFor(() => {
        expect(election2.leader).toBe(true)
        expect(election2.yielded).toBe(false)
        expect(onLeaderGranted2).toHaveBeenCalled()
        expect(onConflict2).toHaveBeenCalledWith(false)
      })

      election2.release()
      vi.useRealTimers()
    })

    it('fallback leader yields immediately when receiving a heartbeat from a true leader', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const onConflictFallback = vi.fn()
      const onRevokedFallback = vi.fn()
      const onGrantedFallback = vi.fn()

      const onConflictTrue = vi.fn()
      const onRevokedTrue = vi.fn()
      const onGrantedTrue = vi.fn()

      let trueLockRelease: (() => void) | null = null
      const requestMock = vi.fn().mockImplementation((name, options, callback) => {
        if (requestMock.mock.calls.length === 1) {
          return new Promise<void>(resolve => {
            trueLockRelease = resolve
            callback()
          })
        }
        // Tab B fails lock acquisition
        return Promise.reject(new Error('Lock acquisition failed for Tab B'))
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

      // Tab A acquires true Web Lock (isFallback: false)
      const electionTrue = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: onGrantedTrue,
          onLeaderRevoked: onRevokedTrue,
          onLeaderConflict: onConflictTrue,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      await electionTrue.acquire()
      expect(electionTrue.leader).toBe(true)
      expect(electionTrue.fallback).toBe(false)
      expect(electionTrue.yielded).toBe(false)

      // Tab B is created in fallback mode after retries fail
      const electionFallback = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: onGrantedFallback,
          onLeaderRevoked: onRevokedFallback,
          onLeaderConflict: onConflictFallback,
        },
        { maxLockRetries: 1, retryDelayMs: 10, presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      await electionFallback.acquire()

      // Tab B receives true leader's heartbeat with isFallback: false
      // Tab B must yield immediately and trigger onLeaderConflict(true)
      await vi.waitFor(() => {
        expect(electionFallback.leader).toBe(false)
        expect(electionFallback.yielded).toBe(true)
        expect(onConflictFallback).toHaveBeenCalledWith(true)
        expect(onRevokedFallback).toHaveBeenCalled()
      })

      // Tab A (true leader) remains active leader
      expect(electionTrue.leader).toBe(true)
      expect(electionTrue.fallback).toBe(false)
      expect(electionTrue.yielded).toBe(false)
      expect(onConflictTrue).not.toHaveBeenCalledWith(true)

      // When Tab A releases, Tab B should auto-recover as fallback leader
      electionTrue.release()
      if (trueLockRelease) trueLockRelease()

      await vi.waitFor(() => {
        expect(electionFallback.leader).toBe(true)
        expect(electionFallback.fallback).toBe(true)
        expect(electionFallback.yielded).toBe(false)
        expect(onConflictFallback).toHaveBeenCalledWith(false)
      })

      electionFallback.release()
      consoleErrorSpy.mockRestore()
      consoleWarnSpy.mockRestore()
    })

    it('fallback leader yields to true leader even if fallback leader was created earlier', async () => {
      const onConflictFallback = vi.fn()
      const onRevokedFallback = vi.fn()

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

      vi.setSystemTime(100)
      const electionFallback = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: onRevokedFallback,
          onLeaderConflict: onConflictFallback,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )
      electionFallback.claimLeadership()
      expect(electionFallback.leader).toBe(true)
      expect(electionFallback.fallback).toBe(true)

      // Later at T=500, a true leader starts
      vi.setSystemTime(500)
      const electionTrue = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: vi.fn(),
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )
      await electionTrue.acquire()
      expect(electionTrue.leader).toBe(true)
      expect(electionTrue.fallback).toBe(false)

      // Even though fallback leader is older (T=100 vs T=500), it MUST yield to the true leader
      await vi.waitFor(() => {
        expect(electionFallback.leader).toBe(false)
        expect(electionFallback.yielded).toBe(true)
        expect(onConflictFallback).toHaveBeenCalledWith(true)
        expect(onRevokedFallback).toHaveBeenCalled()
      })

      expect(electionTrue.leader).toBe(true)
      expect(electionTrue.yielded).toBe(false)

      electionFallback.release()
      electionTrue.release()
      vi.useRealTimers()
    })

    it('true leader that yields to a claim re-grants leadership with isFallback: false when claimer releases', async () => {
      let trueLockRelease: (() => void) | null = null
      const requestMock = vi.fn().mockImplementation((name, options, callback) => {
        return new Promise<void>(resolve => {
          trueLockRelease = resolve
          callback()
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

      const onConflictTrue = vi.fn()
      const electionTrue = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: onConflictTrue,
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      await electionTrue.acquire()
      expect(electionTrue.leader).toBe(true)
      expect(electionTrue.fallback).toBe(false)

      const electionClaimer = new LeaderElection(
        'acc-1',
        {
          onLeaderGranted: vi.fn(),
          onLeaderRevoked: vi.fn(),
          onLeaderConflict: vi.fn(),
        },
        { presenceHeartbeatIntervalMs: 25, presenceTimeoutMs: 100 }
      )

      // Claimer claims leadership
      electionClaimer.claimLeadership()

      // True leader yields to claim
      await vi.waitFor(() => {
        expect(electionTrue.leader).toBe(false)
        expect(electionTrue.yielded).toBe(true)
      })

      // When claimer releases, true leader should un-yield and preserve isFallback: false
      electionClaimer.release()

      await vi.waitFor(() => {
        expect(electionTrue.leader).toBe(true)
        expect(electionTrue.yielded).toBe(false)
        expect(electionTrue.fallback).toBe(false)
      })

      electionTrue.release()
      if (trueLockRelease) trueLockRelease()
    })
  })
})


