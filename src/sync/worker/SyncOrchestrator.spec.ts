import { SyncOrchestrator } from './SyncOrchestrator'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'

describe('SyncOrchestrator', () => {
  let orchestrator: SyncOrchestrator
  let mockBroker: any
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub

  beforeEach(() => {
    vi.useFakeTimers()

    mockBroker = {
      setOnlineState: vi.fn(),
      setSendEnabled: vi.fn(),
      executePoll: vi.fn().mockResolvedValue('success'),
      hasPendingPulls: vi.fn().mockReturnValue(false),
      onFlushNeeded: null,
    }

    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()

    orchestrator = new SyncOrchestrator(
      'account-1',
      mockBroker,
      clientEventHub,
      internalEventHub
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

    it('falls back to broker.loadCursors if pullQueueManager is not directly provided', async () => {
      let resolveReload: () => void = () => {}
      const reloadPromise = new Promise<void>(resolve => {
        resolveReload = resolve
      })
      mockBroker.loadCursors = vi.fn().mockImplementation(() => reloadPromise)

      orchestrator.setLeader(true)

      expect(mockBroker.loadCursors).toHaveBeenCalledTimes(1)

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

  it('notifies onLeaderChange callback when leadership is granted and revoked', async () => {
    const leaderChangeListener = vi.fn()
    orchestrator.onLeaderChange = leaderChangeListener

    expect(orchestrator.leader).toBe(false)

    orchestrator.setLeader(true)
    expect(orchestrator.leader).toBe(true)
    expect(leaderChangeListener).toHaveBeenCalledWith(true)

    orchestrator.setLeader(false)
    expect(orchestrator.leader).toBe(false)
    expect(leaderChangeListener).toHaveBeenCalledWith(false)
  })
})


