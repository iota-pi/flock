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
    await orchestrator.shutdown()

    // Complete in-flight poll
    resolvePoll('success')
    await vi.advanceTimersByTimeAsync(0)

    // Advancing timers further should not trigger any scheduled next polls
    await vi.advanceTimersByTimeAsync(100000)
    expect(mockBroker.executePoll).toHaveBeenCalledTimes(1)
  })
})

