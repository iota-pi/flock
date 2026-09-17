import {
  setupWorkerHealthCheck,
  stopWorkerHeartbeat,
  resetCrashMetrics,
  sendPing,
  recordWorkerActivity,
  MAX_CONSECUTIVE_CRASHES,
  MAX_CONSECUTIVE_TIMEOUTS,
} from './syncWorkerHealth'
import { useAppStore } from '../../state/store'

describe('sendPing', () => {
  let channel: MessageChannel

  beforeEach(() => {
    vi.useFakeTimers()
    channel = new MessageChannel()
  })

  afterEach(() => {
    channel.port1.close()
    channel.port2.close()
    vi.useRealTimers()
  })

  it('resolves on pong and cleans up event listeners', async () => {
    const removeListenerSpy = vi.spyOn(channel.port1, 'removeEventListener')
    channel.port2.onmessage = ev => {
      if (ev.data === 'ping') {
        channel.port2.postMessage('pong')
      }
    }

    const pingPromise = sendPing(channel.port1)
    await expect(pingPromise).resolves.toBeUndefined()
    expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function))
    expect(removeListenerSpy).toHaveBeenCalledWith('messageerror', expect.any(Function))
  })

  it('rejects and cleans up event listeners on signal abort', async () => {
    const removeListenerSpy = vi.spyOn(channel.port1, 'removeEventListener')
    const controller = new AbortController()

    const pingPromise = sendPing(channel.port1, controller.signal)
    controller.abort(new Error('Worker crashed'))

    await expect(pingPromise).rejects.toThrow('Worker crashed')
    expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function))
    expect(removeListenerSpy).toHaveBeenCalledWith('messageerror', expect.any(Function))
  })

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Already aborted'))

    const addListenerSpy = vi.spyOn(channel.port1, 'addEventListener')
    const pingPromise = sendPing(channel.port1, controller.signal)

    await expect(pingPromise).rejects.toThrow('Already aborted')
    expect(addListenerSpy).not.toHaveBeenCalled()
  })

  it('rejects and cleans up on timeout', async () => {
    const removeListenerSpy = vi.spyOn(channel.port1, 'removeEventListener')
    const pingPromise = sendPing(channel.port1, { timeoutMs: 5000 })

    vi.advanceTimersByTime(5000)

    await expect(pingPromise).rejects.toThrow('Heartbeat timeout')
    expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('rejects and cleans up on messageerror', async () => {
    const listeners: Record<string, ((ev: any) => void)[]> = {}
    const mockPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (ev: any) => void) => {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(handler)
      }),
      removeEventListener: vi.fn((event: string, handler: (ev: any) => void) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter(h => h !== handler)
        }
      }),
    } as unknown as MessagePort

    const pingPromise = sendPing(mockPort)
    listeners['messageerror']?.forEach(fn => fn(new Event('messageerror')))

    await expect(pingPromise).rejects.toThrow('MessagePort error')
    expect(mockPort.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    expect(mockPort.removeEventListener).toHaveBeenCalledWith('messageerror', expect.any(Function))
  })

  it('rejects and cleans up when postMessage throws', async () => {
    const removeListenerSpy = vi.spyOn(channel.port1, 'removeEventListener')
    vi.spyOn(channel.port1, 'postMessage').mockImplementation(() => {
      throw new Error('Port closed')
    })

    const pingPromise = sendPing(channel.port1)

    await expect(pingPromise).rejects.toThrow('Port closed')
    expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('cleans up onmessage and onmessageerror when addEventListener is not supported', async () => {
    const mockPort = {
      postMessage: vi.fn(),
      start: vi.fn(),
      onmessage: null as any,
      onmessageerror: null as any,
    } as unknown as MessagePort

    const controller = new AbortController()
    const pingPromise = sendPing(mockPort, controller.signal)

    expect(typeof mockPort.onmessage).toBe('function')
    expect(typeof mockPort.onmessageerror).toBe('function')

    controller.abort(new Error('Manual abort'))
    await expect(pingPromise).rejects.toThrow('Manual abort')

    expect(mockPort.onmessage).toBeNull()
    expect(mockPort.onmessageerror).toBeNull()
  })
})

describe('syncWorkerHealth', () => {
  let mockWorker: any

  beforeEach(() => {
    vi.useFakeTimers()
    resetCrashMetrics()
    useAppStore.setState({ syncStatus: 'idle', fatalError: null, syncWarning: null })
    const listeners: Record<string, ((ev: any) => void)[]> = {}
    mockWorker = {
      terminate: vi.fn(),
      addEventListener: vi.fn((event: string, handler: (ev: any) => void) => {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(handler)
      }),
      removeEventListener: vi.fn((event: string, handler: (ev: any) => void) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter(h => h !== handler)
        }
      }),
      dispatchEvent: vi.fn((event: any) => {
        const handlers = listeners[event.type] || []
        handlers.forEach(h => h(event))
        return true
      }),
    }
  })

  afterEach(() => {
    stopWorkerHeartbeat()
    vi.useRealTimers()
  })

  it('keeps worker alive when pingPort replies with pong', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()
    channel.port2.onmessage = ev => {
      if (ev.data === 'ping') {
        channel.port2.postMessage('pong')
      }
    }

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    // Advance 15s interval + small margin
    await vi.advanceTimersByTimeAsync(15100)
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()

    // Advance another 15s
    await vi.advanceTimersByTimeAsync(15100)
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()

    channel.port1.close()
    channel.port2.close()
  })

  it('triggers crash handling after consecutive heartbeat timeouts (2-stage progressive confirmation)', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()
    // Intentionally do not respond to ping

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    // Advance 15s interval (ping sent) + 29s (timeout is 30s) -> total 44s
    await vi.advanceTimersByTimeAsync(44000)
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()

    // Advance remaining 1000ms -> total 45s (interval 15s + timeout 30s)
    // First timeout triggers warning/probe, not termination
    await vi.advanceTimersByTimeAsync(1000)
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()
    expect(useAppStore.getState().syncWarning).toBe('Sync connection is slow. Checking...')

    // Advance another 45s (15s interval + 30s timeout) -> total 90s (2nd consecutive timeout)
    await vi.advanceTimersByTimeAsync(45000)
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().syncStatus).toBe('connecting')

    channel.port1.close()
    channel.port2.close()
  })

  it('handles worker error events as crash', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()
    const channel = new MessageChannel()

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    mockWorker.dispatchEvent(new ErrorEvent('error', { message: 'Worker crashed' }))
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)

    channel.port1.close()
    channel.port2.close()
  })

  it('aborts in-flight ping and prevents secondary crash handling when worker crashes during ping', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()
    const removeListenerSpy = vi.spyOn(channel.port1, 'removeEventListener')

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    // Advance 15s so ping is sent and in flight
    await vi.advanceTimersByTimeAsync(15000)
    expect(onCrash).not.toHaveBeenCalled()

    // Worker crashes while ping is in flight
    mockWorker.dispatchEvent(new ErrorEvent('error', { message: 'Worker crashed mid-ping' }))
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1)

    // Listeners on pingPort must be cleaned up immediately
    expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function))
    expect(removeListenerSpy).toHaveBeenCalledWith('messageerror', expect.any(Function))

    // Advance 45s (past the 30s heartbeat timeout)
    await vi.advanceTimersByTimeAsync(45000)
    // Must NOT trigger onCrash a second time
    expect(onCrash).toHaveBeenCalledTimes(1)

    channel.port1.close()
    channel.port2.close()
  })

  it('cleans up in-flight ping and listeners when stopWorkerHeartbeat is called', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()
    const removeListenerSpy = vi.spyOn(channel.port1, 'removeEventListener')

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    // Advance 15s to start ping
    await vi.advanceTimersByTimeAsync(15000)

    // Stop heartbeat while ping is in flight
    stopWorkerHeartbeat()

    // Verify listeners were cleaned up
    expect(removeListenerSpy).toHaveBeenCalledWith('message', expect.any(Function))
    expect(removeListenerSpy).toHaveBeenCalledWith('messageerror', expect.any(Function))

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(45000)
    expect(onCrash).not.toHaveBeenCalled()

    channel.port1.close()
    channel.port2.close()
  })

  it('triggers crash immediately on first timeout when maxMissedPings is 1', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
      maxMissedPings: 1,
    })

    // Advance 45s (interval 15s + timeout 30s)
    await vi.advanceTimersByTimeAsync(45000)
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)

    channel.port1.close()
    channel.port2.close()
  })

  it('bypasses crash if worker activity was recently observed', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
      maxMissedPings: 1,
    })

    // Advance 15s so ping is sent
    await vi.advanceTimersByTimeAsync(15000)

    // Advance 25s (total 40s). Worker emits an event (activity observed)
    await vi.advanceTimersByTimeAsync(25000)
    recordWorkerActivity()

    // Advance remaining 5s (total 45s, ping times out)
    await vi.advanceTimersByTimeAsync(5000)

    // Crash should be skipped because activity was recorded within the 30s timeout window
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()

    channel.port1.close()
    channel.port2.close()
  })

  it('recovers and clears warning when pong arrives after an initial missed ping', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    // First ping times out at 45s
    await vi.advanceTimersByTimeAsync(45000)
    expect(useAppStore.getState().syncWarning).toBe('Sync connection is slow. Checking...')
    expect(onCrash).not.toHaveBeenCalled()

    // Setup pong response for the second ping
    channel.port2.onmessage = ev => {
      if (ev.data === 'ping') {
        channel.port2.postMessage('pong')
      }
    }

    // Advance to next heartbeat interval (15s)
    await vi.advanceTimersByTimeAsync(15000)

    // Warning should be cleared on pong, worker not crashed
    expect(useAppStore.getState().syncWarning).toBeNull()
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()

    channel.port1.close()
    channel.port2.close()
  })

  it('skips heartbeat initiation when document.visibilityState is hidden', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()
    const postMessageSpy = vi.spyOn(channel.port1, 'postMessage')

    const originalVisibilityState = document.visibilityState
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })

    try {
      setupWorkerHealthCheck({
        worker: mockWorker,
        pingPort: channel.port1,
        isCurrentWorker: () => true,
        onCrash,
        onRestart,
      })

      // Advance past multiple heartbeat intervals
      await vi.advanceTimersByTimeAsync(45000)
      expect(postMessageSpy).not.toHaveBeenCalled()
      expect(onCrash).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        value: originalVisibilityState,
        configurable: true,
      })
      channel.port1.close()
      channel.port2.close()
    }
  })

  it('detects sleep/timer throttling and discards stale ping without crashing', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    const channel = new MessageChannel()

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: channel.port1,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
      maxMissedPings: 1,
    })

    // Advance 15s to initiate ping
    await vi.advanceTimersByTimeAsync(15000)

    // Simulate system sleep/wake jump: system clock jumps forward by 60s while asleep
    vi.setSystemTime(Date.now() + 60000)
    await vi.advanceTimersByTimeAsync(30000)

    // Worker must NOT be terminated on sleep jump
    expect(onCrash).not.toHaveBeenCalled()
    expect(mockWorker.terminate).not.toHaveBeenCalled()

    channel.port1.close()
    channel.port2.close()
  })

  it('differentiates explicit error vs timeout in crash limits', async () => {
    // 1. Explicit errors halt after MAX_CONSECUTIVE_CRASHES (3)
    resetCrashMetrics()
    for (let i = 1; i < MAX_CONSECUTIVE_CRASHES; i++) {
      const onCrash = vi.fn()
      const onRestart = vi.fn()
      const channel = new MessageChannel()
      setupWorkerHealthCheck({
        worker: mockWorker,
        pingPort: channel.port1,
        isCurrentWorker: () => true,
        onCrash,
        onRestart,
      })
      mockWorker.dispatchEvent(new ErrorEvent('error', { message: 'Explicit crash' }))
      expect(onCrash).toHaveBeenCalledWith(true)
      expect(onRestart).toHaveBeenCalled()
      channel.port1.close()
      channel.port2.close()
    }
    const finalOnCrash = vi.fn()
    const finalOnRestart = vi.fn()
    const finalErrorChannel = new MessageChannel()
    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: finalErrorChannel.port1,
      isCurrentWorker: () => true,
      onCrash: finalOnCrash,
      onRestart: finalOnRestart,
    })
    mockWorker.dispatchEvent(new ErrorEvent('error', { message: 'Explicit crash' }))
    expect(finalOnCrash).toHaveBeenCalledWith(false)
    expect(useAppStore.getState().syncStatus).toBe('dead')
    finalErrorChannel.port1.close()
    finalErrorChannel.port2.close()

    // 2. Timeouts allow up to MAX_CONSECUTIVE_TIMEOUTS (5)
    resetCrashMetrics()
    useAppStore.setState({ syncStatus: 'idle', fatalError: null })
    for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i++) {
      const onCrash = vi.fn()
      const onRestart = vi.fn()
      const channel = new MessageChannel()
      setupWorkerHealthCheck({
        worker: mockWorker,
        pingPort: channel.port1,
        isCurrentWorker: () => true,
        onCrash,
        onRestart,
        maxMissedPings: 1,
      })
      await vi.advanceTimersByTimeAsync(45000)
      expect(onCrash).toHaveBeenCalledWith(true)
      channel.port1.close()
      channel.port2.close()
    }
    const finalTimeoutCrash = vi.fn()
    const finalTimeoutRestart = vi.fn()
    const finalChannel = new MessageChannel()
    setupWorkerHealthCheck({
      worker: mockWorker,
      pingPort: finalChannel.port1,
      isCurrentWorker: () => true,
      onCrash: finalTimeoutCrash,
      onRestart: finalTimeoutRestart,
      maxMissedPings: 1,
    })
    await vi.advanceTimersByTimeAsync(45000)
    expect(finalTimeoutCrash).toHaveBeenCalledWith(false)
    expect(useAppStore.getState().syncStatus).toBe('dead')
    expect(useAppStore.getState().fatalError).toContain('became unresponsive')
    finalChannel.port1.close()
    finalChannel.port2.close()
  })
})
