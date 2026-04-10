import { describe, expect, it, vi, afterEach } from 'vitest'
import { AutomergeSyncTaskQueue } from './automergeSyncTaskQueue'

describe('AutomergeSyncTaskQueue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries retryable tasks with exponential backoff', async () => {
    vi.useFakeTimers()

    const queue = new AutomergeSyncTaskQueue()
    let attempts = 0

    const task = queue.enqueue(async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('temporary failure')
      }

      return 'ok'
    }, {
      shouldRetry: () => true,
      maxRetries: 3,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 100,
    })

    await vi.advanceTimersByTimeAsync(200)

    await expect(task).resolves.toBe('ok')
    expect(attempts).toBe(3)
  })

  it('fails immediately when error is non-retryable', async () => {
    const queue = new AutomergeSyncTaskQueue()
    let attempts = 0

    const task = queue.enqueue(async () => {
      attempts += 1
      throw new Error('validation failed')
    }, {
      shouldRetry: () => false,
      maxRetries: 5,
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 10,
    })

    await expect(task).rejects.toThrow('validation failed')
    expect(attempts).toBe(1)
  })
})