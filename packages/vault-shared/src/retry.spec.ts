import { backOff, getBackoffDelayMs } from './retry'

const options = { baseMs: 100, maxMs: 1000, jitterMs: 50 }

describe('getBackoffDelayMs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('doubles from the base delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect([0, 1, 2, 3].map(attempt => getBackoffDelayMs(attempt, options))).toEqual([100, 200, 400, 800])
  })

  it('caps the delay before adding jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    expect(getBackoffDelayMs(4, options)).toBe(1025)
    expect(getBackoffDelayMs(20, options)).toBe(1025)
  })

  it('adds up to jitterMs of random delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999)

    const delay = getBackoffDelayMs(0, options)
    expect(delay).toBeGreaterThan(149)
    expect(delay).toBeLessThan(150)
  })
})

describe('backOff', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resolves after the backoff delay', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let resolved = false
    const waiting = backOff(1, options).then(() => { resolved = true })

    await vi.advanceTimersByTimeAsync(199)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(resolved).toBe(true)
  })
})
