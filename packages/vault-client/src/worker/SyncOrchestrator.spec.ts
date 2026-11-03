import type { Mock } from 'vitest'
import { SyncOrchestrator, type SyncOrchestratorDeps } from './SyncOrchestrator'
import { SyncSessionState } from './SyncSessionState'
import { ClientEventHub } from './SyncEventHub'
import type { LeaderElection, LeaderElectionCallbacks } from './utils/LeaderElection'
import type { PollOutcome } from './SyncPoller'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const sessions = new WeakMap<SyncOrchestrator, SyncSessionState>()

/** An orchestrator with its own session state, as each context has */
function createOrchestrator(deps: Omit<SyncOrchestratorDeps, 'session'>): SyncOrchestrator {
  const session = new SyncSessionState()
  const created = new SyncOrchestrator({ ...deps, session })
  sessions.set(created, session)
  return created
}

/** Changes the session's online state and tells the orchestrator, as the context does */
function setOnline(target: SyncOrchestrator, isOnline: boolean): void {
  if (sessions.get(target)!.setOnline(isOnline)) {
    target.onOnlineStateChange()
  }
}

/** Marks the session shut down and stops the orchestrator, as the context does */
function shutDown(target: SyncOrchestrator): Promise<void> {
  sessions.get(target)!.markShutdown()
  return target.shutdown()
}

function isLeader(target: SyncOrchestrator): boolean {
  return sessions.get(target)!.isLeader
}

describe('SyncOrchestrator', () => {
  let orchestrator: SyncOrchestrator
  let mockPoller: any
  let mockPullQueueManager: any
  let clientEventHub: ClientEventHub
  let onPollResult: Mock<(outcome: PollOutcome) => void>
  let mockManifestSyncManager: any

  beforeEach(() => {
    vi.useFakeTimers()

    mockManifestSyncManager = {
      sync: vi.fn().mockResolvedValue({ added: [] }),
      abort: vi.fn(),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
    }

    mockPoller = {
      executePoll: vi.fn().mockResolvedValue('success'),
    }

    mockPullQueueManager = {
      loadCursors: vi.fn().mockResolvedValue(undefined),
      hasPendingPulls: vi.fn().mockReturnValue(false),
      hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
    }

    clientEventHub = new ClientEventHub()
    onPollResult = vi.fn()

    orchestrator = createOrchestrator({
      accountId: 'account-1',
      poller: mockPoller,
      clientEventHub,
      pullQueueManager: mockPullQueueManager,
      manifestSyncManager: mockManifestSyncManager,
      onPollResult,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues flush if flush is called during active polling and executes immediately after', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Call flush while poll is in-flight
    orchestrator.flush()
    await vi.advanceTimersByTimeAsync(0)

    // Should not have started a second poll yet because a poll is in flight
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Now resolve the first poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    // Now the pending flush should schedule and execute poll immediately (delay 0)
    await vi.advanceTimersByTimeAsync(10)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
  })

  it('applies jitter to the scheduled poll delay', async () => {
    // The lowest jitter: the 30000ms base delay less half its 7500ms jitter window
    vi.spyOn(Math, 'random').mockReturnValue(0)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(26249)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
  })

  it('handles auth-failure properly and pauses polling even if flush is called during poll', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Call flush while poll is in-flight
    orchestrator.flush()

    const authFailureSpy = vi.fn()
    clientEventHub.subscribe(authFailureSpy)

    // Resolve with auth-failure
    resolvePoll('auth-failure')
    await vi.advanceTimersByTimeAsync(0)

    // Auth failure event should be emitted and internal pollResult emitted
    expect(authFailureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'authFailure', message: expect.stringContaining('session has expired') })
    )
    expect(onPollResult).toHaveBeenCalledWith('auth-failure')

    // Polling should be paused, so advancing timers should not trigger another poll despite flush
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
  })

  it('emits pollResult event when flush is pending after successful poll', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    // Call flush while poll is in-flight
    orchestrator.flush()


    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    expect(onPollResult).toHaveBeenCalledWith('success')

    // Immediate flush execution
    await vi.advanceTimersByTimeAsync(10)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
  })

  it('resumes polling after auth failure when flush is called', async () => {
    mockPoller.executePoll.mockResolvedValueOnce('auth-failure')

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Verify polling is stopped/paused
    await vi.advanceTimersByTimeAsync(60000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // An item change or manual sync triggers flush after re-authenticating
    mockPoller.executePoll.mockResolvedValueOnce('success')
    orchestrator.flush()
    await vi.advanceTimersByTimeAsync(10)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

    // Subsequent scheduled polling should also work
    mockPoller.executePoll.mockResolvedValueOnce('success')
    await vi.advanceTimersByTimeAsync(35000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
  })

  it('resumes polling after auth failure when reconnecting online', async () => {
    mockPoller.executePoll.mockResolvedValueOnce('auth-failure')

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Network goes offline then online
    setOnline(orchestrator, false)
    mockPoller.executePoll.mockResolvedValueOnce('success')
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
  })

  it('preserves pendingFlush when auth-failure occurs and executes it when polling is resumed', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Trigger flush while poll is running
    orchestrator.flush()

    // Poll fails with auth-failure
    resolvePoll('auth-failure')
    await vi.advanceTimersByTimeAsync(0)

    // Polling is paused
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Polling resumes when the device reconnects
    let resolvePoll2: (val: any) => void = () => {}
    const poll2Promise = new Promise(resolve => {
      resolvePoll2 = resolve
    })
    mockPoller.executePoll.mockImplementationOnce(() => poll2Promise)
    setOnline(orchestrator, false)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

    // Resolve poll 2 with success
    mockPoller.executePoll.mockResolvedValueOnce('success')
    resolvePoll2('success')
    await vi.advanceTimersByTimeAsync(0)

    // Because pendingFlush was preserved, after the successful poll it immediately scheduled and executed the queued flush
    await vi.advanceTimersByTimeAsync(10)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
  })

  it('prevents zombie polling when in-flight poll finishes after shutdown', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Shutdown while poll is in flight
    const shutdownPromise = shutDown(orchestrator)

    // Complete in-flight poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)
    await shutdownPromise

    // Advancing timers further should not trigger any scheduled next polls
    await vi.advanceTimersByTimeAsync(100000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
  })

  it('awaits in-flight poll before shutdown promise resolves', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    let shutdownCompleted = false
    const shutdownPromise = shutDown(orchestrator).then(() => {
      shutdownCompleted = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(shutdownCompleted).toBe(false)

    resolvePoll('success')
    await shutdownPromise
    expect(shutdownCompleted).toBe(true)
  })

  it('aborts the in-flight poll on shutdown', async () => {
    let capturedSignal: AbortSignal | undefined
    let resolvePoll: (val: any) => void = () => {}
    mockPoller.executePoll.mockImplementationOnce((signal: AbortSignal) => {
      capturedSignal = signal
      return new Promise(resolve => { resolvePoll = resolve })
    })

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(capturedSignal?.aborted).toBe(false)

    const shutdownPromise = shutDown(orchestrator)
    expect(capturedSignal?.aborted).toBe(true)

    resolvePoll('no-poll')
    await shutdownPromise
  })

  it('does not execute pending flush after shutdown when shutdown occurs before batch timeout fires', async () => {
    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Schedule a flush (batched via setTimeout)
    orchestrator.flush()
    // Poll is not executed synchronously before batch delay
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Shut down before batch timeout fires
    await shutDown(orchestrator)

    // Advancing timers past the batch timeout should not execute any poll
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
  })

  it('stops polling and periodic manifest sync on shutdown (L-7)', async () => {
    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    const polls = mockPoller.executePoll.mock.calls.length
    const manifestSyncs = mockManifestSyncManager.sync.mock.calls.length

    await shutDown(orchestrator)
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.manifestSyncInterval * 2)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(polls)
    expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(manifestSyncs)
  })

  it('shuts down a non-leader without polling or syncing (L-7)', async () => {
    await shutDown(orchestrator)
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.manifestSyncInterval * 2)

    expect(mockPoller.executePoll).not.toHaveBeenCalled()
    expect(mockManifestSyncManager.sync).not.toHaveBeenCalled()
  })

  it('executes poll after batch timeout delay when flush is called', async () => {
    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Call flush
    orchestrator.flush()
    // Poll should not be called synchronously before delay
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Advance timer to fire the batch timeout (0ms / next tick)
    await vi.advanceTimersByTimeAsync(10)
    // Observable behavior: executePoll is called after flush()
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
  })

  it('does not schedule a redundant polling timer alongside the immediate poll on promotion', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })
    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.setLeader(true)
    // Await microtasks for reloadCursors and launch of the immediate poll
    await vi.advanceTimersByTimeAsync(0)

    // An immediate poll was launched, and no redundant scheduled timer should be pending
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Advance time while poll is in-flight: no redundant poll should be triggered
    await vi.advanceTimersByTimeAsync(60000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Finish the poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    // Once poll completed, advancing past the scheduled poll interval executes the next poll
    await vi.advanceTimersByTimeAsync(40000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
  })

  it('does not permanently freeze polling loop and continues polling over time', async () => {
    orchestrator.setLeader(true)
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

    // Trigger timer for second poll
    await vi.advanceTimersByTimeAsync(40000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

    // Trigger timer for third poll
    await vi.advanceTimersByTimeAsync(40000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
  })

  it('polls again at once while the pull queue has more pages, then waits for the scheduled poll', async () => {
    // The first poll leaves more pages to pull (e.g. a pull result with hasMore), the second doesn't
    mockPullQueueManager.hasImmediatePendingPulls.mockReturnValueOnce(true)

    orchestrator.setLeader(true)
    setOnline(orchestrator, true)

    // The second poll is scheduled with 0ms delay, so both polls run at once
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

    // The third poll waits for the 30s poll interval plus jitter
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(50000)
    expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
  })

  it('reports when several tabs lead and when this one leads alone again', async () => {
    const onLeaderOverlapChange = vi.fn()

    let capturedCallbacks!: LeaderElectionCallbacks
    const customOrchestrator = createOrchestrator({
      accountId: 'account-1',
      poller: mockPoller,
      clientEventHub,
      pullQueueManager: mockPullQueueManager,
      manifestSyncManager: mockManifestSyncManager,
      onLeaderOverlapChange,
      createLeaderElection: (_accountId, callbacks) => {
        capturedCallbacks = callbacks
        return {
          acquire: vi.fn().mockResolvedValue(undefined),
          release: vi.fn(),
          claimLeadership: vi.fn(),
        }
      },
    })

    await customOrchestrator.start()

    // Trigger onMultipleLeadersDetected callback
    capturedCallbacks.onMultipleLeadersDetected?.()
    expect(onLeaderOverlapChange).toHaveBeenLastCalledWith(true)

    // Trigger onSoleLeaderRestored callback
    capturedCallbacks.onSoleLeaderRestored?.()
    expect(onLeaderOverlapChange).toHaveBeenLastCalledWith(false)

    await shutDown(customOrchestrator)
  })

  it('forwards leaderConflict event to clientEventHub', async () => {
    const clientListener = vi.fn()
    clientEventHub.subscribe(clientListener)

    let capturedCallbacks!: LeaderElectionCallbacks
    const customOrchestrator = createOrchestrator({
      accountId: 'account-1',
      poller: mockPoller,
      clientEventHub,
      pullQueueManager: mockPullQueueManager,
      manifestSyncManager: mockManifestSyncManager,
      createLeaderElection: (_accountId, callbacks) => {
        capturedCallbacks = callbacks
        return {
          acquire: vi.fn().mockResolvedValue(undefined),
          release: vi.fn(),
          claimLeadership: vi.fn(),
        }
      },
    })

    await customOrchestrator.start()

    // Trigger onLeaderConflict callback
    capturedCallbacks.onLeaderConflict?.(true)
    expect(clientListener).toHaveBeenCalledWith({ type: 'leaderConflict', hasConflict: true })

    capturedCallbacks.onLeaderConflict?.(false)
    expect(clientListener).toHaveBeenCalledWith({ type: 'leaderConflict', hasConflict: false })

    await shutDown(customOrchestrator)
  })

  it('delegates claimLeader to leaderElection.claimLeadership', async () => {
    const mockLeaderElection: Pick<LeaderElection, 'acquire' | 'release' | 'claimLeadership'> = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      claimLeadership: vi.fn(),
    }
    const customOrchestrator = createOrchestrator({
      accountId: 'account-1',
      poller: mockPoller,
      clientEventHub,
      pullQueueManager: mockPullQueueManager,
      manifestSyncManager: mockManifestSyncManager,
      createLeaderElection: () => mockLeaderElection,
    })

    await customOrchestrator.start()

    customOrchestrator.claimLeader()
    expect(mockLeaderElection.claimLeadership).toHaveBeenCalledTimes(1)

    await shutDown(customOrchestrator)
  })

  describe('promoted leader cursor reloading', () => {
    it('reloads cursors via pullQueueManager and awaits reload before polling on promotion', async () => {
      let resolveReload: () => void = () => {}
      const reloadPromise = new Promise<void>(resolve => {
        resolveReload = resolve
      })
      const customPullQueueManager: SyncOrchestratorDeps['pullQueueManager'] = {
        loadCursors: vi.fn().mockImplementation(() => reloadPromise),
        hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
      }

      const orchestratorWithPQM = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: customPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
      })

      // Promote to leader
      orchestratorWithPQM.setLeader(true)

      // loadCursors should have been called
      expect(customPullQueueManager.loadCursors).toHaveBeenCalledTimes(1)

      // Poll must NOT have executed yet because reload is still in-flight
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).not.toHaveBeenCalled()

      // Resolve cursor reload
      resolveReload()
      await vi.advanceTimersByTimeAsync(0)

      // Now poll should execute with reloaded cursors
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      await shutDown(orchestratorWithPQM)
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
      expect(mockPoller.executePoll).not.toHaveBeenCalled()

      resolveReload()
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('cancels poll if leadership is revoked while cursor reload is in-flight', async () => {
      let resolveReload: () => void = () => {}
      const reloadPromise = new Promise<void>(resolve => {
        resolveReload = resolve
      })
      const customPullQueueManager: SyncOrchestratorDeps['pullQueueManager'] = {
        loadCursors: vi.fn().mockImplementation(() => reloadPromise),
        hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
      }

      const orchestratorWithPQM = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: customPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
      })

      orchestratorWithPQM.setLeader(true)
      expect(customPullQueueManager.loadCursors).toHaveBeenCalledTimes(1)

      // Leadership revoked while reloading
      orchestratorWithPQM.setLeader(false)

      // Resolve reload after revoked
      resolveReload()
      await vi.advanceTimersByTimeAsync(0)

      // executePoll must NOT be called
      expect(mockPoller.executePoll).not.toHaveBeenCalled()

      await shutDown(orchestratorWithPQM)
    })
  })

  it('reports leadership changes when leadership is granted and revoked', async () => {
    const leaderChangeListener = vi.fn()
    orchestrator = createOrchestrator({
      accountId: 'account-1',
      poller: mockPoller,
      clientEventHub,
      pullQueueManager: mockPullQueueManager,
      manifestSyncManager: mockManifestSyncManager,
      onLeaderChange: leaderChangeListener,
    })

    expect(isLeader(orchestrator)).toBe(false)

    orchestrator.setLeader(true)
    expect(isLeader(orchestrator)).toBe(true)
    expect(leaderChangeListener).toHaveBeenCalledWith(true)

    orchestrator.setLeader(false)
    expect(isLeader(orchestrator)).toBe(false)
    expect(leaderChangeListener).toHaveBeenCalledWith(false)
  })

  describe('server outage and failure backoff (H9)', () => {
    it('does not bypass exponential backoff with 0ms delay when poll fails with pending flush', async () => {
      let resolvePoll: (val: any) => void = () => {}
      const pollPromise = new Promise(resolve => {
        resolvePoll = resolve
      })

      mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Call flush while poll is in-flight
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(0)

      // Should not have started a second poll yet because a poll is in flight
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Resolve poll with failure (server outage / error)
      mockPoller.executePoll.mockImplementationOnce(() => new Promise(() => {}))
      resolvePoll('failure')
      await vi.advanceTimersByTimeAsync(0)

      // Must NOT schedule with 0ms delay; advancing by short periods should NOT execute a second poll
      await vi.advanceTimersByTimeAsync(10)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Advance past backoff window (step 1 = 60000ms ± 15000ms jitter, max 75000ms)
      await vi.advanceTimersByTimeAsync(50000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('does not trigger immediate poll when flush is called during backoff', async () => {
      mockPoller.executePoll.mockResolvedValueOnce('failure')

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Advance partially into backoff window
      await vi.advanceTimersByTimeAsync(5000)

      // Document edits trigger flush while in backoff
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10)

      // Flush must NOT immediately execute poll or bypass backoff
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('does not reset or starve backoff timer when multiple flushes occur during backoff', async () => {
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      mockPoller.executePoll.mockResolvedValueOnce('success')

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Multiple flushes occur during backoff (e.g. at 10s, 20s, 30s)
      await vi.advanceTimersByTimeAsync(10000)
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10000)
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10000)
      orchestrator.flush()

      // Backoff should not have restarted or starved; advancing to the scheduled window executes poll
      await vi.advanceTimersByTimeAsync(50000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('resets backoff and allows immediate flush once a poll succeeds after earlier failures', async () => {
      // Without jitter, so the next regular poll can't fall inside the 80s window
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      mockPoller.executePoll.mockResolvedValueOnce('success')
      mockPoller.executePoll.mockResolvedValueOnce('success')

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Advance through backoff to second poll (which succeeds)
      await vi.advanceTimersByTimeAsync(80000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

      // Now that system is healthy (outcome === 'success'), flush should trigger immediate poll
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(10)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
    })

    it('schedules next poll with normal interval rather than 0ms when hasImmediatePendingPulls is false', async () => {
      mockPoller.executePoll.mockResolvedValue('success')
      // Simulate retrying or key-blocked items: hasPendingPulls is true, but hasImmediatePendingPulls is false
      mockPullQueueManager.hasPendingPulls.mockReturnValue(true)
      mockPullQueueManager.hasImmediatePendingPulls = vi.fn().mockReturnValue(false)

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Advancing 100ms: should NOT have executed another poll (no 0ms burnout loop)
      await vi.advanceTimersByTimeAsync(100)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Advancing to the scheduled poll interval (~30s base backoff + jitter) executes next poll
      await vi.advanceTimersByTimeAsync(40000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('schedules next poll at 0ms delay when hasImmediatePendingPulls is true', async () => {
      let resolvePoll: (val: any) => void = () => {}
      const firstPollPromise = new Promise(resolve => {
        resolvePoll = resolve
      })

      mockPoller.executePoll.mockImplementationOnce(() => firstPollPromise)
      mockPullQueueManager.hasPendingPulls.mockReturnValue(true)
      mockPullQueueManager.hasImmediatePendingPulls = vi.fn().mockReturnValue(true)

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Resolve the first poll
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)

      // When immediate pulls exist, next poll runs immediately (0ms delay)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })
  })

  describe('onForeground (the user came back to a tab)', () => {
    it('polls at once and resets backoff when polling is backing off', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      mockPoller.executePoll.mockResolvedValueOnce('failure')

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      // The first failure waits 60s, and the second failure 120s
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)

      // The third failure backs off from the start (60s), not from the 300s step
      await vi.advanceTimersByTimeAsync(60000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(4)
    })

    it('polls once the last poll is older than the minimum gap', async () => {
      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.foregroundPollMinGap)
      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('does not start a second poll while one is running', async () => {
      let resolvePoll: (outcome: PollOutcome) => void = () => {}
      mockPoller.executePoll.mockImplementationOnce(() => new Promise(resolve => {
        resolvePoll = resolve
      }))
      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      orchestrator.onForeground()
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('does nothing for a follower or while offline', async () => {
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      setOnline(orchestrator, false)
      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      const follower = createOrchestrator({
        accountId: 'account-2',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: mockPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
      })
      setOnline(follower, true)
      follower.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('does not resume polling that is paused for auth', async () => {
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      mockPoller.executePoll.mockResolvedValueOnce('auth-failure')
      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(80000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })
  })

  describe('poll cadence by visibility', () => {
    let isForeground: boolean

    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      isForeground = true
      orchestrator = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: mockPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
        isForeground: () => isForeground,
      })
    })

    /** Makes the orchestrator the leader, which polls at once */
    async function startPolling(): Promise<void> {
      orchestrator.setLeader(true)
      await vi.advanceTimersByTimeAsync(0)
    }

    it('polls every 30s while a tab is visible', async () => {
      await startPolling()
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('slows to the hidden interval while no tab is visible', async () => {
      isForeground = false
      await startPolling()
      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.hiddenPollInterval - 1)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('keeps failure backoff while hidden', async () => {
      isForeground = false
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      await startPolling()
      await vi.advanceTimersByTimeAsync(60000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('still pushes local changes at once while hidden', async () => {
      isForeground = false
      await startPolling()
      orchestrator.flush()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('polls when the user comes back to a hidden leader', async () => {
      isForeground = false
      await startPolling()
      await vi.advanceTimersByTimeAsync(60000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      isForeground = true
      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(30000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
    })
  })

  describe('manifest sync scheduling & reconnection', () => {
    it('triggers manifest sync on reconnection when leader', async () => {
      orchestrator.setLeader(true)
      await vi.advanceTimersByTimeAsync(0)
      // Initial state is online, reset to offline
      setOnline(orchestrator, false)
      mockManifestSyncManager.sync.mockClear()

      // Reconnect
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledWith(false)
    })

    it('does not trigger manifest sync on reconnection when not leader', async () => {
      orchestrator.setLeader(false)
      setOnline(orchestrator, false)
      mockManifestSyncManager.sync.mockClear()

      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).not.toHaveBeenCalled()
    })

    it('triggers manifest sync and starts periodic schedule on leader promotion when online', async () => {
      const customOrchestrator = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: mockPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
        manifestSyncIntervalMs: 5000,
      })
      setOnline(customOrchestrator, true)
      expect(mockManifestSyncManager.sync).not.toHaveBeenCalled()

      customOrchestrator.setLeader(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledWith(false)

      // Periodic check after 5000ms
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(2)

      await shutDown(customOrchestrator)
    })

    it('periodically runs manifest sync at configured interval', async () => {
      const customOrchestrator = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: mockPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
        manifestSyncIntervalMs: 10000,
      })

      customOrchestrator.setLeader(true)
      setOnline(customOrchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(10000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(3)

      await shutDown(customOrchestrator)
    })

    it('stops periodic manifest sync when going offline', async () => {
      const customOrchestrator = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: mockPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
        manifestSyncIntervalMs: 5000,
      })

      customOrchestrator.setLeader(true)
      setOnline(customOrchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      // Go offline
      setOnline(customOrchestrator, false)

      // Advance time while offline - should NOT trigger manifest sync
      await vi.advanceTimersByTimeAsync(15000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      await shutDown(customOrchestrator)
    })

    it('stops periodic manifest sync when losing leadership', async () => {
      const customOrchestrator = createOrchestrator({
        accountId: 'account-1',
        poller: mockPoller,
        clientEventHub,
        pullQueueManager: mockPullQueueManager,
        manifestSyncManager: mockManifestSyncManager,
        manifestSyncIntervalMs: 5000,
      })

      customOrchestrator.setLeader(true)
      setOnline(customOrchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      // Lose leadership
      customOrchestrator.setLeader(false)

      // Advance time - should NOT trigger manifest sync
      await vi.advanceTimersByTimeAsync(15000)
      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      await shutDown(customOrchestrator)
    })

    it('shutdown stops periodic schedule and waits for the manifest sync manager to go idle', async () => {
      let resolveIdle: () => void = () => {}
      mockManifestSyncManager.waitForIdle.mockImplementation(
        () => new Promise<void>(resolve => { resolveIdle = resolve })
      )

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)

      let shutdownFinished = false
      const shutdownPromise = shutDown(orchestrator).then(() => {
        shutdownFinished = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(shutdownFinished).toBe(false)
      expect(mockManifestSyncManager.abort).toHaveBeenCalled()

      resolveIdle()
      await shutdownPromise
      expect(shutdownFinished).toBe(true)
    })

    it('swallows a failed manifest sync', async () => {
      mockManifestSyncManager.sync.mockRejectedValueOnce(new Error('Manifest sync failed'))

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)
      await shutDown(orchestrator)
    })
  })

  describe('liveness and cancellation', () => {
    it('correctly reports isOperational', async () => {
      expect(orchestrator.isOperational).toBe(false)

      orchestrator.setLeader(true)
      expect(orchestrator.isOperational).toBe(true)

      setOnline(orchestrator, false)
      expect(orchestrator.isOperational).toBe(false)

      setOnline(orchestrator, true)
      expect(orchestrator.isOperational).toBe(true)

      await shutDown(orchestrator)
      expect(orchestrator.isOperational).toBe(false)
    })

    it('aborts in-flight poll when leadership is revoked', async () => {
      let capturedSignal: AbortSignal | undefined
      let resolvePoll: (val: any) => void = () => {}
      mockPoller.executePoll.mockImplementationOnce((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise(resolve => { resolvePoll = resolve })
      })

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Revoke leadership while poll is in-flight
      orchestrator.setLeader(false)

      expect(capturedSignal?.aborted).toBe(true)

      // Resolve after abort
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)

      // Advancing timers should not schedule follower polls
      await vi.advanceTimersByTimeAsync(100000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('aborts in-flight poll when going offline', async () => {
      let capturedSignal: AbortSignal | undefined
      let resolvePoll: (val: any) => void = () => {}
      mockPoller.executePoll.mockImplementationOnce((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise(resolve => { resolvePoll = resolve })
      })

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Go offline while poll is in-flight
      setOnline(orchestrator, false)

      expect(capturedSignal?.aborted).toBe(true)

      // Resolve after abort
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)

      // Advancing timers should not poll while offline
      await vi.advanceTimersByTimeAsync(100000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('aborts in-flight manifest sync when leadership is revoked', async () => {
      mockManifestSyncManager.sync.mockImplementation(() => new Promise<{ added: any[] }>(() => {}))

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)
      expect(mockManifestSyncManager.abort).not.toHaveBeenCalled()

      orchestrator.setLeader(false)

      expect(mockManifestSyncManager.abort).toHaveBeenCalledTimes(1)
    })

    it('aborts in-flight manifest sync when going offline', async () => {
      mockManifestSyncManager.sync.mockImplementation(() => new Promise<{ added: any[] }>(() => {}))

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.sync).toHaveBeenCalledTimes(1)
      expect(mockManifestSyncManager.abort).not.toHaveBeenCalled()

      setOnline(orchestrator, false)

      expect(mockManifestSyncManager.abort).toHaveBeenCalledTimes(1)
    })
  })

  describe('executeWrappedPoll error handling and scheduling (SRP)', () => {
    it('handles thrown error in executePoll by delegating to handlePollError and increasing backoff', async () => {

      mockPoller.executePoll.mockRejectedValueOnce(new Error('Network error'))

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      expect(onPollResult).toHaveBeenCalledWith('failure')

      // Next poll should be delayed by backoff
      await vi.advanceTimersByTimeAsync(10)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      mockPoller.executePoll.mockResolvedValueOnce('success')
      await vi.advanceTimersByTimeAsync(75000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('detects auth error thrown in executePoll and pauses polling via handlePollError', async () => {
      const authFailureSpy = vi.fn()
      clientEventHub.subscribe(authFailureSpy)

      mockPoller.executePoll.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' })

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      expect(authFailureSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'authFailure', message: expect.stringContaining('session has expired') })
      )
      expect(onPollResult).toHaveBeenCalledWith('auth-failure')

      // Polling should be stopped/paused
      await vi.advanceTimersByTimeAsync(100000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('ignores AbortError thrown in executePoll without emitting failure or altering backoff', async () => {

      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockPoller.executePoll.mockRejectedValueOnce(abortError)

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      expect(onPollResult).not.toHaveBeenCalledWith('failure')
    })

    it('continues scheduling next poll timer when the poll result receiver throws', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      onPollResult.mockImplementation(() => {
        throw new Error('listener failure')
      })

      orchestrator.setLeader(true)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // Advance timer by poll backoff delay to verify the timer executes the subsequent poll
      await vi.advanceTimersByTimeAsync(40000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

      consoleErrorSpy.mockRestore()
    })
  })
})

