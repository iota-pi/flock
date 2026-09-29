import {
  RetryStrategy,
  DEFAULT_RETRY_DELAYS,
  DEFAULT_POLL_BACKOFF_DELAYS,
} from './RetryStrategy'

describe('RetryStrategy', () => {
  it('uses DEFAULT_RETRY_DELAYS by default', () => {
    const strategy = new RetryStrategy()
    expect(strategy.delays).toEqual(DEFAULT_RETRY_DELAYS)
    expect(strategy.delays).toEqual([2000, 5000, 10000, 30000, 60000])
  })

  it('steps through delays with nextDelay() and clamps at the last delay', () => {
    const strategy = new RetryStrategy()
    expect(strategy.attempt).toBe(0)
    expect(strategy.currentBaseDelay).toBe(2000)

    expect(strategy.nextDelay()).toBe(2000)
    expect(strategy.attempt).toBe(1)

    expect(strategy.nextDelay()).toBe(5000)
    expect(strategy.attempt).toBe(2)

    expect(strategy.nextDelay()).toBe(10000)
    expect(strategy.attempt).toBe(3)

    expect(strategy.nextDelay()).toBe(30000)
    expect(strategy.attempt).toBe(4)

    expect(strategy.nextDelay()).toBe(60000)
    expect(strategy.attempt).toBe(5)

    // Clamps at 60000
    expect(strategy.nextDelay()).toBe(60000)
    expect(strategy.attempt).toBe(6)
  })

  it('resets attempt counter on reset()', () => {
    const strategy = new RetryStrategy()
    strategy.nextDelay()
    strategy.nextDelay()
    expect(strategy.attempt).toBe(2)

    strategy.reset()
    expect(strategy.attempt).toBe(0)
    expect(strategy.currentBaseDelay).toBe(2000)
  })

  it('allows manual attempt setting and enforces non-negative attempt', () => {
    const strategy = new RetryStrategy()
    strategy.attempt = 3
    expect(strategy.attempt).toBe(3)
    expect(strategy.currentBaseDelay).toBe(30000)

    strategy.attempt = -5
    expect(strategy.attempt).toBe(0)
  })

  it('supports custom delay array', () => {
    const strategy = new RetryStrategy({ delays: [100, 200, 500] })
    expect(strategy.nextDelay()).toBe(100)
    expect(strategy.nextDelay()).toBe(200)
    expect(strategy.nextDelay()).toBe(500)
    expect(strategy.nextDelay()).toBe(500)
  })

  it('handles empty delay schedule gracefully', () => {
    const strategy = new RetryStrategy({ delays: [] })
    expect(strategy.currentBaseDelay).toBe(0)
    expect(strategy.nextDelay()).toBe(0)
  })

  describe('max attempts & exhaustion', () => {
    it('has infinite attempts when maxAttempts is undefined', () => {
      const strategy = new RetryStrategy()
      expect(strategy.canRetry).toBe(true)
      expect(strategy.isExhausted).toBe(false)

      strategy.attempt = 100
      expect(strategy.canRetry).toBe(true)
      expect(strategy.isExhausted).toBe(false)
    })

    it('enforces maxAttempts limit correctly', () => {
      const strategy = new RetryStrategy({ maxAttempts: 3 })
      expect(strategy.canRetry).toBe(true)
      expect(strategy.isExhausted).toBe(false)

      strategy.nextDelay() // attempt 0 -> 1
      expect(strategy.canRetry).toBe(true)
      expect(strategy.isExhausted).toBe(false)

      strategy.nextDelay() // attempt 1 -> 2
      expect(strategy.canRetry).toBe(true)
      expect(strategy.isExhausted).toBe(false)

      strategy.nextDelay() // attempt 2 -> 3
      expect(strategy.canRetry).toBe(false)
      expect(strategy.isExhausted).toBe(true)
    })
  })

  describe('increment with clampToLast', () => {
    it('clamps to last delay index when clampToLast is true', () => {
      const strategy = new RetryStrategy({ delays: DEFAULT_POLL_BACKOFF_DELAYS })
      // DEFAULT_POLL_BACKOFF_DELAYS has length 4 (indices 0, 1, 2, 3)
      expect(strategy.attempt).toBe(0)

      strategy.increment({ clampToLast: true })
      expect(strategy.attempt).toBe(1)

      strategy.increment({ clampToLast: true })
      expect(strategy.attempt).toBe(2)

      strategy.increment({ clampToLast: true })
      expect(strategy.attempt).toBe(3)

      // Should remain clamped at 3
      strategy.increment({ clampToLast: true })
      expect(strategy.attempt).toBe(3)
      expect(strategy.currentBaseDelay).toBe(300000)
    })

    it('does not clamp when clampToLast is omitted', () => {
      const strategy = new RetryStrategy({ delays: [100, 200] })
      strategy.increment()
      strategy.increment()
      strategy.increment()
      expect(strategy.attempt).toBe(3)
    })
  })

  describe('jitter calculation', () => {
    it('returns original delay if jitter window is zero or negative', () => {
      expect(RetryStrategy.applyJitter(0)).toBe(0)
      expect(RetryStrategy.applyJitter(-100)).toBe(-100)
    })

    it('uses deterministic randomFn for jitter bounds testing', () => {
      // 60000ms with factor 0.25 -> window is min(15000, 15000) = 15000.
      // offset = floor(randomFn() * 15001) - 7500
      // When randomFn returns 0: offset = -7500 -> delay = 52500
      const minJitter = RetryStrategy.applyJitter(60000, {
        factor: 0.25,
        maxJitterMs: 15000,
        randomFn: () => 0,
      })
      expect(minJitter).toBe(52500)

      // When randomFn returns 0.999999: offset = 15000 - 7500 = 7500 -> delay = 67500
      const maxJitter = RetryStrategy.applyJitter(60000, {
        factor: 0.25,
        maxJitterMs: 15000,
        randomFn: () => 0.999999,
      })
      expect(maxJitter).toBe(67500)

      // Midpoint: offset ~ 0
      const midJitter = RetryStrategy.applyJitter(60000, {
        factor: 0.25,
        maxJitterMs: 15000,
        randomFn: () => 0.5,
      })
      expect(midJitter).toBe(60000)
    })

    it('produces symmetric jitter centered around target delay over many samples', () => {
      const samples: number[] = []
      for (let i = 0; i < 1000; i++) {
        samples.push(RetryStrategy.applyJitter(60000))
      }
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length
      expect(avg).toBeGreaterThan(57000)
      expect(avg).toBeLessThan(63000)
    })

    it('applies jitter in strategy when jitter option is true', () => {
      const strategy = new RetryStrategy({
        delays: [60000],
        jitter: true,
      })
      // Delay returned from currentDelay should be in [52500, 67500]
      const delay = strategy.currentDelay
      expect(delay).toBeGreaterThanOrEqual(52500)
      expect(delay).toBeLessThanOrEqual(67500)
    })

    it('never returns negative delay even with extreme offset', () => {
      const jittered = RetryStrategy.applyJitter(10, {
        factor: 2.0,
        maxJitterMs: 100,
        randomFn: () => 0,
      })
      expect(jittered).toBeGreaterThanOrEqual(0)
    })
  })

  describe('static helpers', () => {
    it('computeDelay computes delay with clamping and optional jitter', () => {
      expect(RetryStrategy.computeDelay([1000, 2000], 0)).toBe(1000)
      expect(RetryStrategy.computeDelay([1000, 2000], 1)).toBe(2000)
      expect(RetryStrategy.computeDelay([1000, 2000], 5)).toBe(2000)

      const jittered = RetryStrategy.computeDelay([60000], 0, { jitter: true })
      expect(jittered).toBeGreaterThanOrEqual(52500)
      expect(jittered).toBeLessThanOrEqual(67500)
    })
  })

  describe('executeWithRetry', () => {
    it('executes operation successfully on initial attempt without retrying', async () => {
      const op = vi.fn().mockResolvedValue('success')
      const onRetry = vi.fn()

      const result = await RetryStrategy.executeWithRetry(op, {
        delays: [10, 20],
        onRetry,
      })

      expect(result).toBe('success')
      expect(op).toHaveBeenCalledTimes(1)
      expect(op).toHaveBeenCalledWith(1)
      expect(onRetry).not.toHaveBeenCalled()
    })

    it('retries on failure and returns successful result on subsequent attempt', async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce('success on 3')

      const onRetry = vi.fn()
      const result = await RetryStrategy.executeWithRetry(op, {
        delays: [0, 0, 0],
        maxAttempts: 3,
        onRetry,
      })

      expect(result).toBe('success on 3')
      expect(op).toHaveBeenCalledTimes(3)
      expect(op).toHaveBeenNthCalledWith(1, 1)
      expect(op).toHaveBeenNthCalledWith(2, 2)
      expect(op).toHaveBeenNthCalledWith(3, 3)
      expect(onRetry).toHaveBeenCalledTimes(2)
      expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1, 0)
      expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2, 0)
    })

    it('exhausts maxAttempts and throws the last error', async () => {
      const op = vi.fn().mockImplementation(attempt => {
        throw new Error(`Attempt ${attempt} failed`)
      })

      await expect(
        RetryStrategy.executeWithRetry(op, {
          delays: [0, 0],
          maxAttempts: 3,
        })
      ).rejects.toThrow('Attempt 3 failed')

      expect(op).toHaveBeenCalledTimes(3)
    })

    it('stops retrying immediately if shouldRetry returns false', async () => {
      class FatalError extends Error {
        isFatal = true
      }

      const op = vi.fn().mockRejectedValue(new FatalError('Fatal error'))
      const shouldRetry = vi.fn().mockImplementation(err => !(err instanceof FatalError))

      await expect(
        RetryStrategy.executeWithRetry(op, {
          delays: [0, 0],
          maxAttempts: 3,
          shouldRetry,
        })
      ).rejects.toThrow('Fatal error')

      expect(op).toHaveBeenCalledTimes(1)
      expect(shouldRetry).toHaveBeenCalledTimes(1)
    })

    it('supports async shouldRetry predicate', async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce('recovered')

      const shouldRetry = vi.fn().mockResolvedValue(true)

      const result = await RetryStrategy.executeWithRetry(op, {
        delays: [0],
        maxAttempts: 2,
        shouldRetry,
      })

      expect(result).toBe('recovered')
      expect(op).toHaveBeenCalledTimes(2)
      expect(shouldRetry).toHaveBeenCalledTimes(1)
    })

    it('rejects immediately without executing operation if AbortSignal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort(new Error('Pre-aborted'))

      const op = vi.fn().mockResolvedValue('ok')

      await expect(
        RetryStrategy.executeWithRetry(op, {
          delays: [0],
          signal: controller.signal,
        })
      ).rejects.toThrow('Pre-aborted')

      expect(op).not.toHaveBeenCalled()
    })

    it('cancels delay and rejects immediately when AbortSignal fires during retry delay', async () => {
      const controller = new AbortController()
      const op = vi.fn().mockRejectedValue(new Error('Fail'))

      const retryPromise = RetryStrategy.executeWithRetry(op, {
        delays: [5000],
        maxAttempts: 3,
        signal: controller.signal,
      })

      // Allow attempt 1 to fail and enter delay
      await new Promise(r => setTimeout(r, 10))
      expect(op).toHaveBeenCalledTimes(1)

      controller.abort(new Error('Aborted during delay'))

      await expect(retryPromise).rejects.toThrow('Aborted during delay')
      expect(op).toHaveBeenCalledTimes(1)
    })

    it('works as an instance method on a RetryStrategy instance', async () => {
      const strategy = new RetryStrategy({
        delays: [0, 0],
        maxAttempts: 2,
      })

      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('first fail'))
        .mockResolvedValueOnce('instance ok')

      const result = await strategy.executeWithRetry(op)

      expect(result).toBe('instance ok')
      expect(op).toHaveBeenCalledTimes(2)
      expect(strategy.attempt).toBe(1)
    })

    it('yields to the event loop macrotask queue even when delay is 0ms', async () => {
      let macrotaskExecuted = false
      setTimeout(() => {
        macrotaskExecuted = true
      }, 0)

      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error('try again'))
        .mockImplementationOnce(() => {
          expect(macrotaskExecuted).toBe(true)
          return 'ok'
        })

      const result = await RetryStrategy.executeWithRetry(op, {
        delays: [0],
        maxAttempts: 2,
      })

      expect(result).toBe('ok')
      expect(macrotaskExecuted).toBe(true)
    })
  })
})

