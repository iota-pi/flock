import type { Mock, MockInstance } from 'vitest'
import { SyncOrchestrator, type SyncOrchestratorDeps } from './SyncOrchestrator'
import type { PollCadence } from './pollSchedule'
import { SyncSessionState } from './SyncSessionState'
import { ClientEventHub } from './SyncEventHub'
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

describe('SyncOrchestrator', () => {
  let orchestrator: SyncOrchestrator
  let mockPoller: any
  let mockPuller: any
  let clientEventHub: ClientEventHub
  let onPollResult: Mock<(outcome: PollOutcome) => void>
  let mockManifestSyncManager: any

  beforeEach(() => {
    vi.useFakeTimers()

    mockManifestSyncManager = {
      // Each ask's handle reads as already served, unless a test opens it, so every event asks again
      ask: vi.fn(() => {
        const handle = {
          isOpen: false,
          result: undefined as unknown,
          close: vi.fn(() => handle.result ?? { added: [], success: false, fetchedManifest: false }),
        }
        return handle
      }),
      getDueAt: vi.fn(() => undefined),
    }

    mockPoller = {
      executePoll: vi.fn().mockResolvedValue('success'),
    }

    mockPuller = {
      loadState: vi.fn().mockResolvedValue(undefined),
      hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
      gapRepollDelay: undefined,
    }

    clientEventHub = new ClientEventHub()
    onPollResult = vi.fn()

    orchestrator = createOrchestrator({
      poller: mockPoller,
      clientEventHub,
      puller: mockPuller,
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

    orchestrator.start()
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

    orchestrator.start()
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

    orchestrator.start()
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

  it('resumes polling after auth failure when flush is called', async () => {
    mockPoller.executePoll.mockResolvedValueOnce('auth-failure')

    orchestrator.start()
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

  it('prevents zombie polling when in-flight poll finishes after shutdown', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })

    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.start()
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

    orchestrator.start()
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

    orchestrator.start()
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(capturedSignal?.aborted).toBe(false)

    const shutdownPromise = shutDown(orchestrator)
    expect(capturedSignal?.aborted).toBe(true)

    resolvePoll('no-poll')
    await shutdownPromise
  })

  it('does not execute pending flush after shutdown when shutdown occurs before batch timeout fires', async () => {
    orchestrator.start()
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

  it('stops polling, and with it the manifest sync, on shutdown (L-7)', async () => {
    orchestrator.start()
    setOnline(orchestrator, true)
    await vi.advanceTimersByTimeAsync(0)
    const polls = mockPoller.executePoll.mock.calls.length

    await shutDown(orchestrator)
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.manifestSyncInterval * 2)

    expect(mockPoller.executePoll).toHaveBeenCalledTimes(polls)
  })

  it('shuts down a session that never started without polling or syncing (L-7)', async () => {
    await shutDown(orchestrator)
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.manifestSyncInterval * 2)

    expect(mockPoller.executePoll).not.toHaveBeenCalled()
    expect(mockManifestSyncManager.ask).not.toHaveBeenCalled()
  })

  it('executes poll after batch timeout delay when flush is called', async () => {
    orchestrator.start()
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

  it('does not schedule a redundant polling timer alongside the immediate poll on start', async () => {
    let resolvePoll: (val: any) => void = () => {}
    const pollPromise = new Promise(resolve => {
      resolvePoll = resolve
    })
    mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

    orchestrator.start()
    // Await microtasks for reloadState and launch of the immediate poll
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

  it('polls again at once while the pull queue has more pages, then waits for the scheduled poll', async () => {
    // The first poll leaves more pages to pull (e.g. a pull result with hasMore), the second doesn't
    mockPuller.hasImmediatePendingPulls.mockReturnValueOnce(true)

    orchestrator.start()
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

  describe('server outage and failure backoff (H9)', () => {
    it('does not bypass exponential backoff with 0ms delay when poll fails with pending flush', async () => {
      let resolvePoll: (val: any) => void = () => {}
      const pollPromise = new Promise(resolve => {
        resolvePoll = resolve
      })

      mockPoller.executePoll.mockImplementationOnce(() => pollPromise)

      orchestrator.start()
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

    it('does not reset or starve backoff timer when multiple flushes occur during backoff', async () => {
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      // The retry never finishes, so a jittered poll after it can't land in the window below
      mockPoller.executePoll.mockImplementationOnce(() => new Promise(() => {}))

      orchestrator.start()
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

    it('polls again after the gap delay, and never at 0ms, while waiting on a gap', async () => {
      mockPoller.executePoll.mockResolvedValue('success')
      mockPuller.gapRepollDelay = 1000

      orchestrator.start()
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(100)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // The delay plus jitter
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockPoller.executePoll.mock.calls.length).toBeGreaterThan(1)
    })
  })

  describe('onForeground (the user came back to a tab)', () => {
    it('polls once the last poll is older than the minimum gap', async () => {
      orchestrator.start()
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

    it('does nothing while offline', async () => {
      mockPoller.executePoll.mockResolvedValueOnce('failure')
      orchestrator.start()
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      setOnline(orchestrator, false)
      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('asks for a manifest sync, which skips itself when one ran recently', async () => {
      orchestrator.start()
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      mockManifestSyncManager.ask.mockClear()

      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockManifestSyncManager.ask).toHaveBeenCalledTimes(1)
      expect(mockManifestSyncManager.ask).toHaveBeenLastCalledWith({ mode: 'due', until: 'served' })

      setOnline(orchestrator, false)
      mockManifestSyncManager.ask.mockClear()
      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockManifestSyncManager.ask).not.toHaveBeenCalled()
    })

    it('asks only once while its earlier ask is still waiting for a phase', async () => {
      orchestrator.start()
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      mockManifestSyncManager.ask.mockReturnValue({ isOpen: true, close: vi.fn() })
      orchestrator.onForeground()
      mockManifestSyncManager.ask.mockClear()

      orchestrator.onForeground()
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.ask).not.toHaveBeenCalled()
    })
  })

  // The table in pollSchedule.spec.ts covers the decisions; these check the orchestrator passes the
  // cadence and snapshot due time through, and that its timers fire when the schedule says
  describe('cadence and snapshot due time', () => {
    let cadence: PollCadence
    let snapshotDueAt: number | undefined
    let random: MockInstance<() => number>

    beforeEach(() => {
      // 0.5 puts the 30s idle poll in the middle of its jitter window, so it lands at exactly 30s
      random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
      cadence = 'idle'
      snapshotDueAt = undefined
      orchestrator = createOrchestrator({
        poller: mockPoller,
        clientEventHub,
        puller: mockPuller,
        manifestSyncManager: mockManifestSyncManager,
        getCadence: () => cadence,
        getSnapshotDueAt: () => snapshotDueAt,
      })
    })

    /** Starts the orchestrator, which polls at once */
    async function startPolling(): Promise<void> {
      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)
    }

    /** The polls that ran by 1ms before `delayMs` from now, and by `delayMs`: [0, 1] when the next is due then */
    async function pollsAround(delayMs: number): Promise<[number, number]> {
      const before = mockPoller.executePoll.mock.calls.length
      await vi.advanceTimersByTimeAsync(delayMs - 1)
      const justBefore = mockPoller.executePoll.mock.calls.length - before
      await vi.advanceTimersByTimeAsync(1)
      return [justBefore, mockPoller.executePoll.mock.calls.length - before]
    }

    it('polls every 10-15s while the user is active, picking at random each time', async () => {
      cadence = 'active'
      random.mockReturnValue(0)
      await startPolling()
      // Each poll draws the next delay as it finishes
      random.mockReturnValue(0.99999)
      expect(await pollsAround(SYNC_TIMEOUTS.activePollMin)).toEqual([0, 1])
      expect(await pollsAround(SYNC_TIMEOUTS.activePollMax)).toEqual([0, 1])
    })

    it('brings an idle poll forward when activity starts', async () => {
      await startPolling()
      await vi.advanceTimersByTimeAsync(1000)

      cadence = 'active'
      orchestrator.onActivity()
      expect(await pollsAround(12500)).toEqual([0, 1])
    })

    it('schedules the next poll for when snapshots are due, if that is sooner than the cadence', async () => {
      snapshotDueAt = Date.now() + 5000
      await startPolling()

      expect(await pollsAround(5000)).toEqual([0, 1])
    })

    // The case that matters: a hidden tab polls every 5-10 min, but an edit's snapshot is due in 30s
    it('brings a hidden poll forward to when snapshots become due', async () => {
      cadence = 'hidden'
      await startPolling()
      await vi.advanceTimersByTimeAsync(1000)

      snapshotDueAt = Date.now() + 30_000
      orchestrator.onSnapshotDue()

      expect(await pollsAround(30_000)).toEqual([0, 1])
    })
  })

  describe('pollNow', () => {
    it('runs a poll and resolves once it has finished', async () => {
      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      await orchestrator.pollNow()

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('waits for the poll in flight, then runs another', async () => {
      let resolveFirst!: (outcome: PollOutcome) => void
      mockPoller.executePoll.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)

      let finished = false
      const polled = orchestrator.pollNow().then(() => { finished = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(finished).toBe(false)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      resolveFirst('success')
      await polled

      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    it('does nothing once shut down', async () => {
      await shutDown(orchestrator)
      await orchestrator.pollNow()

      expect(mockPoller.executePoll).not.toHaveBeenCalled()
    })
  })

  describe('manifest sync as a phase of the poll', () => {
    it('asks for a manifest sync on reconnection', async () => {
      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)
      setOnline(orchestrator, false)
      mockManifestSyncManager.ask.mockClear()
      mockPoller.executePoll.mockClear()

      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockManifestSyncManager.ask).toHaveBeenCalledWith({ mode: 'due', until: 'served' })
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
    })

    it('asks for a manifest sync on start, before the poll that runs it', async () => {
      const order: string[] = []
      mockManifestSyncManager.ask.mockImplementation(() => {
        order.push('request')
        return { isOpen: false, close: vi.fn() }
      })
      mockPoller.executePoll.mockImplementation(async () => {
        order.push('poll')
        return 'success'
      })

      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)

      expect(order).toEqual(['request', 'poll'])
      expect(mockManifestSyncManager.ask).toHaveBeenCalledWith({ mode: 'due', until: 'served' })
    })

    it('runs no manifest sync of its own: there is no timer beside the poll', async () => {
      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)
      setOnline(orchestrator, false)
      mockPoller.executePoll.mockClear()

      await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.manifestSyncInterval * 2)

      expect(mockPoller.executePoll).not.toHaveBeenCalled()
    })

    it('brings the next poll forward to when a manifest sync is due', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      orchestrator.start()
      mockManifestSyncManager.getDueAt.mockImplementation(() => Date.now() + 5000)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      mockManifestSyncManager.getDueAt.mockReturnValue(undefined)

      await vi.advanceTimersByTimeAsync(4999)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
    })

    describe('syncManifest', () => {
      const SERVED = { added: [], success: true, fetchedManifest: true }

      it('returns the result of the sync the poll ran for its ticket', async () => {
        orchestrator.start()
        await vi.advanceTimersByTimeAsync(0)
        mockPoller.executePoll.mockImplementation(async () => {
          mockManifestSyncManager.ask.mock.results.at(-1).value.result = SERVED
          return 'success'
        })

        await expect(orchestrator.syncManifest('force')).resolves.toEqual(SERVED)

        expect(mockManifestSyncManager.ask).toHaveBeenLastCalledWith({ mode: 'force', until: 'served' })
        expect(mockManifestSyncManager.ask.mock.results.at(-1).value.close).toHaveBeenCalledTimes(1)
      })

      it('opens its ticket only after the poll in flight, so that poll can\'t fail it', async () => {
        let resolveFirst!: (outcome: PollOutcome) => void
        mockPoller.executePoll.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
        orchestrator.start()
        await vi.advanceTimersByTimeAsync(0)

        mockManifestSyncManager.ask.mockClear()
        const synced = orchestrator.syncManifest('due')
        await vi.advanceTimersByTimeAsync(0)
        expect(mockManifestSyncManager.ask).not.toHaveBeenCalled()

        resolveFirst('failure')
        await synced

        expect(mockManifestSyncManager.ask).toHaveBeenCalledTimes(1)
        expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)
      })

      it('returns a failure, leaving nothing asked for, when the poll fails before its manifest phase', async () => {
        orchestrator.start()
        await vi.advanceTimersByTimeAsync(0)
        mockPoller.executePoll.mockResolvedValue('failure')

        const result = await orchestrator.syncManifest('force')

        expect(result).toEqual({ added: [], success: false, fetchedManifest: false })
        expect(mockManifestSyncManager.ask).toHaveBeenLastCalledWith({ mode: 'force', until: 'served' })
        expect(mockManifestSyncManager.ask.mock.results.at(-1).value.close).toHaveBeenCalledTimes(1)
      })

      it('returns a failure without polling while offline', async () => {
        setOnline(orchestrator, false)
        const result = await orchestrator.syncManifest('due')

        expect(result.success).toBe(false)
        expect(mockPoller.executePoll).not.toHaveBeenCalled()
      })

      it('returns a failure rather than hang when the poll is aborted', async () => {
        orchestrator.start()
        await vi.advanceTimersByTimeAsync(0)
        mockPoller.executePoll.mockImplementation((signal: AbortSignal) => new Promise(resolve => {
          signal.addEventListener('abort', () => resolve('no-poll'))
        }))

        const synced = orchestrator.syncManifest('due')
        await vi.advanceTimersByTimeAsync(0)
        setOnline(orchestrator, false)

        await expect(synced).resolves.toEqual({ added: [], success: false, fetchedManifest: false })
      })
    })
  })

  describe('liveness and cancellation', () => {
    it('correctly reports isOperational', async () => {
      orchestrator.start()
      expect(orchestrator.isOperational).toBe(true)

      setOnline(orchestrator, false)
      expect(orchestrator.isOperational).toBe(false)

      setOnline(orchestrator, true)
      expect(orchestrator.isOperational).toBe(true)

      await shutDown(orchestrator)
      expect(orchestrator.isOperational).toBe(false)
    })

    it('keeps polling when the device is back online before an aborted poll has settled', async () => {
      let resolvePoll: (val: PollOutcome) => void = () => {}
      mockPoller.executePoll.mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve }))

      orchestrator.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(1)

      // The poll ignores its abort signal and settles only after the device is back online
      setOnline(orchestrator, false)
      setOnline(orchestrator, true)
      await vi.advanceTimersByTimeAsync(0)
      resolvePoll('success')
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(40_000)
      expect(mockPoller.executePoll).toHaveBeenCalledTimes(3)
    })

    it('aborts in-flight poll when going offline', async () => {
      let capturedSignal: AbortSignal | undefined
      let resolvePoll: (val: any) => void = () => {}
      mockPoller.executePoll.mockImplementationOnce((signal: AbortSignal) => {
        capturedSignal = signal
        return new Promise(resolve => { resolvePoll = resolve })
      })

      orchestrator.start()
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
  })

  describe('executeWrappedPoll error handling and scheduling (SRP)', () => {
    it('handles thrown error in executePoll by delegating to handlePollError and increasing backoff', async () => {

      mockPoller.executePoll.mockRejectedValueOnce(new Error('Network error'))

      orchestrator.start()
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

      orchestrator.start()
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

      orchestrator.start()
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

      orchestrator.start()
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

