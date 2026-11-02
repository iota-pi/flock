import { ConsecutiveFailureCounter } from './ConsecutiveFailureCounter'

describe('ConsecutiveFailureCounter', () => {
  it('counts failures per key until the limit, then resets the key', () => {
    const counter = new ConsecutiveFailureCounter<string>(3)

    expect(counter.recordFailure('a')).toBe(1)
    expect(counter.recordFailure('b')).toBe(1)
    expect(counter.recordFailure('a')).toBe(2)

    const failures = counter.recordFailure('a')
    expect(failures).toBe(3)
    expect(counter.isExhausted(failures)).toBe(true)

    expect(counter.recordFailure('a')).toBe(1)
    expect(counter.recordFailure('b')).toBe(2)
  })

  it('reset and clear drop counts', () => {
    const counter = new ConsecutiveFailureCounter<string>(5)
    counter.recordFailure('a')
    counter.recordFailure('b')
    counter.recordFailure('c')

    counter.reset('a')
    expect(counter.recordFailure('a')).toBe(1)
    expect(counter.isExhausted(counter.recordFailure('b'))).toBe(false)

    counter.clear()
    expect(counter.recordFailure('b')).toBe(1)
    expect(counter.recordFailure('c')).toBe(1)
  })
})
