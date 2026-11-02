import { ConsecutiveFailureCounter } from './ConsecutiveFailureCounter'

describe('ConsecutiveFailureCounter', () => {
  it('counts failures per key until the limit, then resets the key', () => {
    const counter = new ConsecutiveFailureCounter<string>(3)

    expect(counter.recordFailure('a')).toBe(false)
    expect(counter.recordFailure('b')).toBe(false)
    expect(counter.recordFailure('a')).toBe(false)
    expect(counter.count('a')).toBe(2)

    expect(counter.recordFailure('a')).toBe(true)
    expect(counter.count('a')).toBe(0)

    expect(counter.recordFailure('a')).toBe(false)
    expect(counter.count('a')).toBe(1)
    expect(counter.recordFailure('b')).toBe(false)
    expect(counter.count('b')).toBe(2)
  })

  it('reset and clear drop counts', () => {
    const counter = new ConsecutiveFailureCounter<string>(5)
    counter.recordFailure('a')
    counter.recordFailure('b')
    counter.recordFailure('c')

    counter.reset('a')
    expect(counter.count('a')).toBe(0)
    expect(counter.recordFailure('b')).toBe(false)
    expect(counter.count('b')).toBe(2)

    counter.clear()
    expect(counter.count('b')).toBe(0)
    expect(counter.count('c')).toBe(0)
  })
})
