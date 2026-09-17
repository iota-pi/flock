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
})
