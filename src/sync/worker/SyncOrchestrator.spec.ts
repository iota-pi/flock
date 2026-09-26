import { SyncOrchestrator } from './SyncOrchestrator'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'

describe('SyncOrchestrator', () => {
  let orchestrator: SyncOrchestrator
  let mockBroker: any
  let mockPoller: any
  let mockPullQueueManager: any
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub

  beforeEach(() => {
    vi.useFakeTimers()

    mockPoller = {
      executePoll: vi.fn().mockResolvedValue('success'),
      abort: vi.fn(),
    }

    mockBroker = {
      setOnlineState: vi.fn(),
      setSendEnabled: vi.fn(),
      poller: mockPoller,
    }

    mockPullQueueManager = {
      loadCursors: vi.fn().mockResolvedValue(undefined),
      hasPendingPulls: vi.fn().mockReturnValue(false),
      hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
    }

    Object.defineProperty(mockBroker, 'executePoll', {
      get: () => mockPoller.executePoll,
      set: fn => { mockPoller.executePoll = fn },
      configurable: true,
    })
    Object.defineProperty(mockBroker, 'hasPendingPulls', {
      get: () => mockPullQueueManager.hasPendingPulls,
      set: fn => { mockPullQueueManager.hasPendingPulls = fn },
      configurable: true,
    })
    Object.defineProperty(mockBroker, 'hasImmediatePendingPulls', {
      get: () => mockPullQueueManager.hasImmediatePendingPulls,
      set: fn => { mockPullQueueManager.hasImmediatePendingPulls = fn },
      configurable: true,
    })
    Object.defineProperty(mockBroker, 'abortPoll', {
      get: () => mockPoller.abort,
      set: fn => { mockPoller.abort = fn },
      configurable: true,
    })
    Object.defineProperty(mockBroker, 'loadCursors', {
      get: () => mockPullQueueManager.loadCursors,
      set: fn => { mockPullQueueManager.loadCursors = fn },
      configurable: true,
    })

    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()

    orchestrator = new SyncOrchestrator(
      'account-1',
      mockBroker,
      clientEventHub,
      internalEventHub,
      mockPullQueueManager
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues flush if flush is called during active polling and executes immediately after', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Call flush while poll is in-flight
    orchestrator.flush()
    await vi.advanceTimersByTimeAsync(0)

    // Should not have started a second poll yet because isPolling is true
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Now resolve the first poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    // Now the pending flush should schedule and execute poll immediately (delay 0)
    await vi.advanceTimersByTimeAsync(10)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
  })

  it('applies symmetric jitter centered around target delay', () => {
    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)

    // Access private method applyBackoffJitter for testing
    const applyJitter = (orchestrator as any).applyBackoffJitter.bind(orchestrator)

    const samples: number[] = []
    for (let i = 0; i < 1000; i++) {
      samples.push(applyJitter(60000))
    }

    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    // Target is 60000, jitter window is 15000, so delay ranges 52500 - 67500. Average should be ~60000.
    expect(avg).toBeGreaterThan(57000)
    expect(avg).toBeLessThan(63000)
  })

  it('handles auth-failure properly and pauses polling even if flush is called during poll', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Call flush while poll is in-flight
    orchestrator.flush()

    const authFailureSpy = vi.fn()
    clientEventHub.subscribe(authFailureSpy)
    const internalPollResultSpy = vi.fn()
    internalEventHub.subscribe(internalPollResultSpy)

    // Resolve with auth-failure
    resolvePoll('auth-failure')
    await vi.advanceTimersByTimeAsync(0)

    // Auth failure event should be emitted and internal pollResult emitted
    expect(authFailureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'authFailure', message: expect.stringContaining('session has expired') })
    )
    expect(internalPollResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pollResult', outcome: 'auth-failure' })
    )

    // Polling should be paused, so advancing timers should not trigger another poll despite flush
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
  })

  it('emits pollResult event when flush is pending after successful poll', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    // Call flush while poll is in-flight
    orchestrator.flush()

    const internalPollResultSpy = vi.fn()
    internalEventHub.subscribe(internalPollResultSpy)

    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    expect(internalPollResultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pollResult', outcome: 'success' })
    )

    // Immediate flush execution
    await vi.advanceTimersByTimeAsync(10)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
  })

  it('resumes polling after auth failure when startPolling is called', async () => {
    mockBroker.executePoll.mockResolvedValueOnce('auth-failure')

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Verify polling is stopped/paused
    await vi.advanceTimersByTimeAsync(60000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // User re-authenticates and startPolling is called
    mockBroker.executePoll.mockResolvedValueOnce('success')
    orchestrator.startPolling(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)

    // Subsequent scheduled polling should also work
    mockBroker.executePoll.mockResolvedValueOnce('success')
    await vi.advanceTimersByTimeAsync(35000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(3)
  })

  it('resumes polling after auth failure when flush is called', async () => {
    mockBroker.executePoll.mockResolvedValueOnce('auth-failure')

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Verify polling is stopped/paused
    await vi.advanceTimersByTimeAsync(60000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // An item change or manual sync triggers flush after re-authenticating
    mockBroker.executePoll.mockResolvedValueOnce('success')
    orchestrator.flush()
    await vi.advanceTimersByTimeAsync(10)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)

    // Subsequent scheduled polling should also work
    mockBroker.executePoll.mockResolvedValueOnce('success')
    await vi.advanceTimersByTimeAsync(35000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(3)
  })

  it('resumes polling after auth failure when reconnecting online', async () => {
    mockBroker.executePoll.mockResolvedValueOnce('auth-failure')

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Network goes offline then online
    orchestrator.setOnlineState(false)
    mockBroker.executePoll.mockResolvedValueOnce('success')
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
  })

  it('preserves pendingFlush when auth-failure occurs and executes it when polling is resumed', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Trigger flush while poll is running
    orchestrator.flush()

    // Poll fails with auth-failure
    resolvePoll('auth-failure')
    await vi.advanceTimersByTimeAsync(0)

    // Polling is paused
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Start polling without immediate flag (e.g. standard schedule)
    let resolvePoll2: (val: any) => void = () => {}
    const poll2Promise = new Promise(resolve => {
      resolvePoll2 = resolve
    })
    mockBroker.executePoll.mockImplementationOnce(() => poll2Promise)
    orchestrator.startPolling(false)

    // Advance timer to the scheduled poll time
    await vi.advanceTimersByTimeAsync(35000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)

    // Resolve poll 2 with success
    mockBroker.executePoll.mockResolvedValueOnce('success')
    resolvePoll2('success')
    await vi.advanceTimersByTimeAsync(0)

    // Because pendingFlush was preserved, after the successful poll it immediately scheduled and executed the queued flush
    await vi.advanceTimersByTimeAsync(10)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(3)
  })

  it('prevents zombie polling when in-flight poll finishes after shutdown', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

    // Shutdown while poll is in flight
    const shutdownPromise = orchestrator.shutdown()

    // Complete in-flight poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)
    await shutdownPromise

    // Advancing timers further should not trigger any scheduled next polls
    await vi.advanceTimersByTimeAsync(100000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
  })

  it('awaits in-flight poll before shutdown promise resolves', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    let shutdownCompleted = false
    const shutdownPromise = orchestrator.shutdown().then(() => {
      shutdownCompleted = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(shutdownCompleted).toBe(false)

    resolvePoll('success')
    await shutdownPromise
    expect(shutdownCompleted).toBe(true)
  })

  it('calls abortPoll on broker during shutdown if available', async () => {
    mockBroker.abortPoll = vi.fn()
    await orchestrator.shutdown()
    expect(mockBroker.abortPoll).toHaveBeenCalledTimes(1)
  })

  it('does not set pendingFlush when shutting down with a pending batch timeout', async () => {
    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)

    // Schedule a flush (syncBatchTimeout)
    orchestrator.flush()
    expect((orchestrator as any).syncBatchTimeout).not.toBeNull()

    // Shut down before batch timeout fires
    await orchestrator.shutdown()

    expect((orchestrator as any).pendingFlush).toBe(false)
  })

  it('does not schedule a redundant polling timer when startPolling is called with immediate=true', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })
    mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    // At this point startPolling(true) was invoked by setLeader(true).
    // An immediate poll was launched, and no redundant scheduled timer should be pending.
    expect((orchestrator as any).pollIntervalId).toBeNull()

    // Finish the poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    // Once poll completed, it should schedule the next poll
    expect((orchestrator as any).pollIntervalId).not.toBeNull()
  })

  it('does not permanently freeze polling loop if timer fires slightly early due to timer resolution', async () => {
    orchestrator.setLeader(true)
    orchestrator.setOnlineState(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
    expect((orchestrator as any).pollIntervalId).not.toBeNull()

    // Simulate browser timer resolution where setTimeout fires 1ms before target timestamp
    const scheduledPollAt = (orchestrator as any).nextPollAt ?? (Date.now() + 30000)
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(scheduledPollAt - 1)

    // Trigger timer
    await vi.advanceTimersByTimeAsync(40000)

    // The second poll must execute despite firing 1ms early
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)

    dateNowSpy.mockRestore()
    await vi.advanceTimersByTimeAsync(40000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(3)
  })

  it('forwards multipleLeadersDetected and soleLeaderRestored events to internalEventHub', async () => {
    const internalListener = vi.fn()
    internalEventHub.subscribe(internalListener)

    await orchestrator.start()
    const leaderElection = (orchestrator as any).leaderElection

    // Trigger onMultipleLeadersDetected callback
    leaderElection.callbacks.onMultipleLeadersDetected?.()
    expect(internalListener).toHaveBeenCalledWith({ type: 'multipleLeadersDetected' })

    // Trigger onSoleLeaderRestored callback
    leaderElection.callbacks.onSoleLeaderRestored?.()
    expect(internalListener).toHaveBeenCalledWith({ type: 'soleLeaderRestored' })

    await orchestrator.shutdown()
  })

  it('forwards leaderConflict event to internalEventHub and clientEventHub', async () => {
    const internalListener = vi.fn()
    const clientListener = vi.fn()
    internalEventHub.subscribe(internalListener)
    clientEventHub.subscribe(clientListener)

    await orchestrator.start()
    const leaderElection = (orchestrator as any).leaderElection

    // Trigger onLeaderConflict callback
    leaderElection.callbacks.onLeaderConflict?.(true)
    expect(internalListener).toHaveBeenCalledWith({ type: 'leaderConflict', hasConflict: true })
    expect(clientListener).toHaveBeenCalledWith({ type: 'leaderConflict', hasConflict: true })

    leaderElection.callbacks.onLeaderConflict?.(false)
    expect(internalListener).toHaveBeenCalledWith({ type: 'leaderConflict', hasConflict: false })
    expect(clientListener).toHaveBeenCalledWith({ type: 'leaderConflict', hasConflict: false })

    await orchestrator.shutdown()
  })

  it('delegates claimLeader to leaderElection.claimLeadership', async () => {
    await orchestrator.start()
    const leaderElection = (orchestrator as any).leaderElection
    const claimSpy = vi.spyOn(leaderElection, 'claimLeadership')

    orchestrator.claimLeader()
    expect(claimSpy).toHaveBeenCalledTimes(1)

    await orchestrator.shutdown()
  })

  describe('promoted leader cursor reloading', () => {
    it('reloads cursors via pullQueueManager and awaits reload before polling on promotion', async () => {
      let resolveReload: () => void = () => {}
      const reloadPromise = new Promise<void>(resolve => {
        resolveReload = resolve
      })
      const mockPullQueueManager = {
        loadCursors: vi.fn().mockImplementation(() => reloadPromise),
      }

      const orchestratorWithPQM = new SyncOrchestrator(
        'account-1',
        mockBroker,
        clientEventHub,
        internalEventHub,
        mockPullQueueManager as any
      )

      // Promote to leader
      orchestratorWithPQM.setLeader(true)

      // loadCursors should have been called
      expect(mockPullQueueManager.loadCursors).toHaveBeenCalledTimes(1)

      // Poll must NOT have executed yet because reload is still in-flight
      await vi.advanceTimersByTimeAsync(0)
      expect(mockBroker.executePoll).not.toHaveBeenCalled()

      // Resolve cursor reload
      resolveReload()
      await vi.advanceTimersByTimeAsync(0)

      // Now poll should execute with reloaded cursors
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      await orchestratorWithPQM.shutdown()
    })

    it('reloads cursors on leader promotion before executing poll', async () => {
      let resolveReload: () => void = () => {}
      const reloadPromise = new Promise<void>(resolve => {
        resolveReload = resolve
      })
      mockPullQueueManager.loadCursors = vi.fn().mockImplementation(() => reloadPromise)

      orchestrator.setLeader(true)

      expect(mockPullQueueManager.loadCursors).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(0)
      expect(mockBroker.executePoll).not.toHaveBeenCalled()

      resolveReload()
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
    })

    it('cancels poll if leadership is revoked while cursor reload is in-flight', async () => {
      let resolveReload: () => void = () => {}
      const reloadPromise = new Promise<void>(resolve => {
        resolveReload = resolve
      })
      const mockPullQueueManager = {
        loadCursors: vi.fn().mockImplementation(() => reloadPromise),
      }

      const orchestratorWithPQM = new SyncOrchestrator(
        'account-1',
        mockBroker,
        clientEventHub,
        internalEventHub,
        mockPullQueueManager as any
      )

      orchestratorWithPQM.setLeader(true)
      expect(mockPullQueueManager.loadCursors).toHaveBeenCalledTimes(1)

      // Leadership revoked while reloading
      orchestratorWithPQM.setLeader(false)

      // Resolve reload after revoked
      resolveReload()
      await vi.advanceTimersByTimeAsync(0)

      // executePoll must NOT be called
      expect(mockBroker.executePoll).not.toHaveBeenCalled()

      await orchestratorWithPQM.shutdown()
    })
  })

  it('emits leaderChange on internalEventHub when leadership is granted and revoked', async () => {
    const leaderChangeListener = vi.fn()
    internalEventHub.subscribe(e => {
      if (e.type === 'leaderChange') leaderChangeListener(e.isLeader)
    })

    expect(orchestrator.leader).toBe(false)

    orchestrator.setLeader(true)
    expect(orchestrator.leader).toBe(true)
    expect(leaderChangeListener).toHaveBeenCalledWith(true)

    orchestrator.setLeader(false)
    expect(orchestrator.leader).toBe(false)
    expect(leaderChangeListener).toHaveBeenCalledWith(false)
  })

  describe('server outage and failure backoff (H9)', () => {
    it('does not bypass exponential backoff with 0ms delay when poll fails with pending flush', async () => {
      let resolvePoll: (val: any) => void = () => {}
      const pollPromise = new Promise(resolve => {
        resolvePoll = resolve
      })

      mockBroker.executePoll.mockImplementationOnce(() => pollPromise)

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Call flush while poll is in-flight
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(0)

      // Should not have started a second poll yet because isPolling is true
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Resolve poll with failure (server outage / error)
      mockBroker.executePoll.mockImplementationOnce(() => new Promise(() => {}))
      resolvePoll('failure')
      await vi.advanceTimersByTimeAsync(0)

      // Must NOT schedule with 0ms delay; advancing by short periods should NOT execute a second poll
      await vi.advanceTimersByTimeAsync(10)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Advance past backoff window (step 1 = 60000ms ± 15000ms jitter, max 75000ms)
      await vi.advanceTimersByTimeAsync(50000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
    })

    it('does not trigger immediate poll when flush is called during backoff', async () => {
      mockBroker.executePoll.mockResolvedValueOnce('failure')

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Advance partially into backoff window
      await vi.advanceTimersByTimeAsync(5000)

      // Document edits trigger flush while in backoff
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10)

      // Flush must NOT immediately execute poll or bypass backoff
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
    })

    it('does not reset or starve backoff timer when multiple flushes occur during backoff', async () => {
      mockBroker.executePoll.mockResolvedValueOnce('failure')
      mockBroker.executePoll.mockResolvedValueOnce('success')

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Multiple flushes occur during backoff (e.g. at 10s, 20s, 30s)
      await vi.advanceTimersByTimeAsync(10000)
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10000)
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10000)
      orchestrator.flush()

      // Backoff should not have restarted or starved; advancing to the scheduled window executes poll
      await vi.advanceTimersByTimeAsync(50000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
    })

    it('resets backoff and allows immediate flush once a poll succeeds after earlier failures', async () => {
      mockBroker.executePoll.mockResolvedValueOnce('failure')
      mockBroker.executePoll.mockResolvedValueOnce('success')
      mockBroker.executePoll.mockResolvedValueOnce('success')

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Advance through backoff to second poll (which succeeds)
      await vi.advanceTimersByTimeAsync(80000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)

      // Now that system is healthy (outcome === 'success'), flush should trigger immediate poll
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(3)
    })

    it('schedules next poll with normal interval rather than 0ms when hasImmediatePendingPulls is false', async () => {
      mockBroker.executePoll.mockResolvedValue('success')
      // Simulate retrying or key-blocked items: hasPendingPulls is true, but hasImmediatePendingPulls is false
      mockBroker.hasPendingPulls.mockReturnValue(true)
      mockBroker.hasImmediatePendingPulls = vi.fn().mockReturnValue(false)

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Advancing 100ms: should NOT have executed another poll (no 0ms burnout loop)
      await vi.advanceTimersByTimeAsync(100)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Advancing to the scheduled poll interval (~30s base backoff + jitter) executes next poll
      await vi.advanceTimersByTimeAsync(40000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
    })

    it('schedules next poll at 0ms delay when hasImmediatePendingPulls is true', async () => {
      let resolvePoll: (val: any) => void = () => {}
      const firstPollPromise = new Promise(resolve => {
        resolvePoll = resolve
      })

      mockBroker.executePoll.mockImplementationOnce(() => firstPollPromise)
      mockBroker.hasPendingPulls.mockReturnValue(true)
      mockBroker.hasImmediatePendingPulls = vi.fn().mockReturnValue(true)

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      // Resolve the first poll
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)

      // When immediate pulls exist, next poll runs immediately (0ms delay)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
    })
  })

  describe('manifest sync scheduling & reconnection', () => {
    let mockManifestSyncManager: any

    beforeEach(() => {
      mockManifestSyncManager = {
        sync: vi.fn().mockResolvedValue({ added: [] }),
      }
    })

    it('triggers manifest sync on reconnection when leader', async () => {
      orchestrator.setManifestSyncManager(mockManifestSyncManager)
      orchestrator.setLeader(true)
      await vi.advanceTimersByTimeAsync(0)
      // Initial state is online, reset to offline
      orchestrator.setOnlineState(false)
      mockManifestSyncManager.sync.mockClear()

      // Reconnect
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledWith(false, expect.any(AbortSignal))
    })

    it('does not trigger manifest sync on reconnection when not leader', async () => {
      orchestrator.setManifestSyncManager(mockManifestSyncManager)
      orchestrator.setLeader(false)
      orchestrator.setOnlineState(false)
      mockManifestSyncManager.sync.mockClear()

      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).not.toHaveBeenCalled()
    })

    it('triggers manifest sync and starts periodic schedule on leader promotion when online', async () => {
      const customOrchestrator = new SyncOrchestrator(
        'account-1',
        mockBroker,
        clientEventHub,
        internalEventHub,
        mockPullQueueManager,
        mockManifestSyncManager,
        { manifestSyncIntervalMs: 5000 }
      )
      customOrchestrator.setOnlineState(true)
      expect(mockManifestSyncManager.sync).not.toHaveBeenCalled()

      customOrchestrator.setLeader(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledWith(false, expect.any(AbortSignal))

      // Periodic check after 5000ms
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(2)

      await customOrchestrator.shutdown()
    })

    it('periodically runs manifest sync at configured interval', async () => {
      const customOrchestrator = new SyncOrchestrator(
        'account-1',
        mockBroker,
        clientEventHub,
        internalEventHub,
        mockPullQueueManager,
        mockManifestSyncManager,
        { manifestSyncIntervalMs: 10000 }
      )

      customOrchestrator.setLeader(true)
      customOrchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(10000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(3)

      await customOrchestrator.shutdown()
    })

    it('stops periodic manifest sync when going offline', async () => {
      const customOrchestrator = new SyncOrchestrator(
        'account-1',
        mockBroker,
        clientEventHub,
        internalEventHub,
        mockPullQueueManager,
        mockManifestSyncManager,
        { manifestSyncIntervalMs: 5000 }
      )

      customOrchestrator.setLeader(true)
      customOrchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      // Go offline
      customOrchestrator.setOnlineState(false)

      // Advance time while offline - should NOT trigger manifest sync
      await vi.advanceTimersByTimeAsync(15000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      await customOrchestrator.shutdown()
    })

    it('stops periodic manifest sync when losing leadership', async () => {
      const customOrchestrator = new SyncOrchestrator(
        'account-1',
        mockBroker,
        clientEventHub,
        internalEventHub,
        mockPullQueueManager,
        mockManifestSyncManager,
        { manifestSyncIntervalMs: 5000 }
      )

      customOrchestrator.setLeader(true)
      customOrchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      // Lose leadership
      customOrchestrator.setLeader(false)

      // Advance time - should NOT trigger manifest sync
      await vi.advanceTimersByTimeAsync(15000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      await customOrchestrator.shutdown()
    })

    it('shutdown stops periodic schedule and awaits in-flight manifest sync', async () => {
      let resolveSync: (val: any) => void = () => {}
      mockManifestSyncManager.sync.mockImplementation(
        () => new Promise(resolve => { resolveSync = resolve })
      )

      orchestrator.setManifestSyncManager(mockManifestSyncManager)
      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      let shutdownFinished = false
      const shutdownPromise = orchestrator.shutdown().then(() => {
        shutdownFinished = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(shutdownFinished).toBe(false)

      resolveSync({ added: [] })
      await shutdownPromise
      expect(shutdownFinished).toBe(true)
    })

    it('prevents concurrent manifest syncs on rapid online/offline toggles', async () => {
      let resolveSync: (val: any) => void = () => {}
      mockManifestSyncManager.sync.mockImplementation(
        () => new Promise(resolve => { resolveSync = resolve })
      )

      orchestrator.setManifestSyncManager(mockManifestSyncManager)
      orchestrator.setLeader(true)
      // First sync is now initiated and in-flight
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      // Rapidly toggle online/offline multiple times while sync is in flight
      orchestrator.setOnlineState(false)
      orchestrator.setOnlineState(true)
      orchestrator.setOnlineState(false)
      orchestrator.setOnlineState(true)
      orchestrator.setOnlineState(false)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      // Must NOT have spawned additional concurrent manifest syncs
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      // Finish the active sync
      resolveSync({ added: [] })
      await vi.advanceTimersByTimeAsync(0)

      // Now that the active sync has resolved, a subsequent reconnection can trigger a new sync
      orchestrator.setOnlineState(false)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(2)
    })

    it('returns existing in-flight promise when triggerManifestSync is called concurrently', async () => {
      let resolveSync: (val: any) => void = () => {}
      mockManifestSyncManager.sync.mockImplementation(
        () => new Promise(resolve => { resolveSync = resolve })
      )

      orchestrator.setManifestSyncManager(mockManifestSyncManager)
      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)

      const p1 = orchestrator.triggerManifestSync()
      const p2 = orchestrator.triggerManifestSync()

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      let p1Resolved = false
      let p2Resolved = false
      p1.then(() => { p1Resolved = true })
      p2.then(() => { p2Resolved = true })

      await vi.advanceTimersByTimeAsync(0)
      expect(p1Resolved).toBe(false)
      expect(p2Resolved).toBe(false)

      resolveSync({ added: [] })
      await vi.advanceTimersByTimeAsync(0)

      expect(p1Resolved).toBe(true)
      expect(p2Resolved).toBe(true)
    })
  })

  describe('liveness and cancellation', () => {
    it('correctly reports isOperational and isPolling', async () => {
      expect(orchestrator.isOperational).toBe(false)
      expect(orchestrator.isPolling).toBe(false)

      orchestrator.setLeader(true)
      expect(orchestrator.isOperational).toBe(true)

      orchestrator.setOnlineState(false)
      expect(orchestrator.isOperational).toBe(false)

      orchestrator.setOnlineState(true)
      expect(orchestrator.isOperational).toBe(true)

      await orchestrator.shutdown()
      expect(orchestrator.isOperational).toBe(false)
    })

    it('aborts in-flight poll when leadership is revoked', async () => {
      mockBroker.abortPoll = vi.fn()
      let resolvePoll: (val: any) => void = () => {}
      mockBroker.executePoll.mockImplementationOnce(
        () => new Promise(resolve => { resolvePoll = resolve })
      )

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      expect(orchestrator.isPolling).toBe(true)

      // Revoke leadership while poll is in-flight
      orchestrator.setLeader(false)

      expect(mockBroker.abortPoll).toHaveBeenCalledTimes(1)

      // Resolve after abort
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)

      expect(orchestrator.isPolling).toBe(false)
      // Advancing timers should not schedule follower polls
      await vi.advanceTimersByTimeAsync(100000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
    })

    it('aborts in-flight poll when going offline', async () => {
      mockBroker.abortPoll = vi.fn()
      let resolvePoll: (val: any) => void = () => {}
      mockBroker.executePoll.mockImplementationOnce(
        () => new Promise(resolve => { resolvePoll = resolve })
      )

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      expect(orchestrator.isPolling).toBe(true)

      // Go offline while poll is in-flight
      orchestrator.setOnlineState(false)

      expect(mockBroker.abortPoll).toHaveBeenCalledTimes(1)

      // Resolve after abort
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)

      expect(orchestrator.isPolling).toBe(false)
      // Advancing timers should not poll while offline
      await vi.advanceTimersByTimeAsync(100000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
    })

    it('aborts in-flight manifest sync when leadership is revoked', async () => {
      let capturedSignal: AbortSignal | undefined
      const mockManifest = {
        sync: vi.fn((_force?: boolean, signal?: AbortSignal) => {
          capturedSignal = signal
          return new Promise<{ added: any[] }>(() => {})
        }),
        abort: vi.fn(),
      }

      orchestrator.setManifestSyncManager(mockManifest)
      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifest.sync).toHaveBeenCalledTimes(1)
      expect(capturedSignal).toBeDefined()
      expect(capturedSignal?.aborted).toBe(false)

      orchestrator.setLeader(false)

      expect(capturedSignal?.aborted).toBe(true)
      expect(mockManifest.abort).toHaveBeenCalledTimes(1)
    })

    it('aborts in-flight manifest sync when going offline', async () => {
      let capturedSignal: AbortSignal | undefined
      const mockManifest = {
        sync: vi.fn((_force?: boolean, signal?: AbortSignal) => {
          capturedSignal = signal
          return new Promise<{ added: any[] }>(() => {})
        }),
        abort: vi.fn(),
      }

      orchestrator.setManifestSyncManager(mockManifest)
      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifest.sync).toHaveBeenCalledTimes(1)
      expect(capturedSignal?.aborted).toBe(false)

      orchestrator.setOnlineState(false)

      expect(capturedSignal?.aborted).toBe(true)
      expect(mockManifest.abort).toHaveBeenCalledTimes(1)
    })
  })

  describe('executeWrappedPoll error handling and scheduling (SRP)', () => {
    it('handles thrown error in executePoll by delegating to handlePollError and increasing backoff', async () => {
      const internalPollResultSpy = vi.fn()
      internalEventHub.subscribe(internalPollResultSpy)

      mockBroker.executePoll.mockRejectedValueOnce(new Error('Network error'))

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      expect(internalPollResultSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pollResult', outcome: 'failure' })
      )

      // Next poll should be delayed by backoff
      await vi.advanceTimersByTimeAsync(10)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)

      mockBroker.executePoll.mockResolvedValueOnce('success')
      await vi.advanceTimersByTimeAsync(75000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(2)
    })

    it('detects auth error thrown in executePoll and pauses polling via handlePollError', async () => {
      const authFailureSpy = vi.fn()
      clientEventHub.subscribe(authFailureSpy)
      const internalPollResultSpy = vi.fn()
      internalEventHub.subscribe(internalPollResultSpy)

      mockBroker.executePoll.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' })

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      expect(authFailureSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'authFailure', message: expect.stringContaining('session has expired') })
      )
      expect(internalPollResultSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pollResult', outcome: 'auth-failure' })
      )

      // Polling should be stopped/paused
      await vi.advanceTimersByTimeAsync(100000)
      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
    })

    it('ignores AbortError thrown in executePoll without emitting failure or altering backoff', async () => {
      const internalPollResultSpy = vi.fn()
      internalEventHub.subscribe(internalPollResultSpy)

      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockBroker.executePoll.mockRejectedValueOnce(abortError)

      orchestrator.setLeader(true)
      orchestrator.setOnlineState(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
      expect(internalPollResultSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure' })
      )
    })
  })
})

