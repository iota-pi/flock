import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  setupWorkerHealthCheck,
  stopWorkerHeartbeat,
  resetCrashMetrics,
} from './syncWorkerHealth'
import { useAppStore } from '../../state/store'

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
      removeEventListener: vi.fn(),
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

  it('triggers crash handling after 30s heartbeat timeout', async () => {
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
    await vi.advanceTimersByTimeAsync(1000)
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().syncStatus).toBe('connecting')

    channel.port1.close()
    channel.port2.close()
  })

  it('supports pingFn as fallback', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()
    const pingFn = vi.fn().mockResolvedValue(undefined)

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingFn,
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    await vi.advanceTimersByTimeAsync(15000)
    expect(pingFn).toHaveBeenCalledTimes(1)
    expect(onCrash).not.toHaveBeenCalled()
  })

  it('handles worker error events as crash', async () => {
    const onCrash = vi.fn()
    const onRestart = vi.fn()

    setupWorkerHealthCheck({
      worker: mockWorker,
      pingFn: vi.fn(),
      isCurrentWorker: () => true,
      onCrash,
      onRestart,
    })

    mockWorker.dispatchEvent(new ErrorEvent('error', { message: 'Worker crashed' }))
    expect(onCrash).toHaveBeenCalledTimes(1)
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledTimes(1)
  })
})
