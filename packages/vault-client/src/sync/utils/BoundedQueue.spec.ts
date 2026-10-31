import { BoundedQueue } from './BoundedQueue'

describe('BoundedQueue', () => {
  it('enforces positive finite maxCapacity in constructor', () => {
    expect(() => new BoundedQueue(0)).toThrow(RangeError)
    expect(() => new BoundedQueue(-5)).toThrow(RangeError)
    expect(() => new BoundedQueue(NaN)).toThrow(RangeError)
    expect(() => new BoundedQueue(Infinity)).toThrow(RangeError)
  })

  it('pushes and shifts items in FIFO order', () => {
    const queue = new BoundedQueue<string>(3)
    expect(queue.shift()).toBeUndefined()

    queue.push('a')
    queue.push('b')
    queue.push('c')
    expect(queue.length).toBe(3)

    expect(queue.shift()).toBe('a')
    expect(queue.shift()).toBe('b')
    expect(queue.shift()).toBe('c')
    expect(queue.shift()).toBeUndefined()
    expect(queue.length).toBe(0)
  })

  it('evicts the oldest item when a push exceeds capacity', () => {
    const onEvict = vi.fn()
    const queue = new BoundedQueue<number>(3, onEvict)

    queue.push(1)
    queue.push(2)
    queue.push(3)
    expect(onEvict).not.toHaveBeenCalled()

    queue.push(4)
    expect([...queue]).toEqual([2, 3, 4])
    expect(onEvict).toHaveBeenCalledWith(1)

    queue.push(5)
    expect([...queue]).toEqual([3, 4, 5])
    expect(onEvict).toHaveBeenCalledWith(2)
    expect(onEvict).toHaveBeenCalledTimes(2)
  })

  it('clears all items', () => {
    const queue = new BoundedQueue<string>(3)
    queue.push('x')
    queue.push('y')
    queue.clear()
    expect(queue.length).toBe(0)
    expect([...queue]).toEqual([])
  })

  it('filters in place, keeping order', () => {
    const queue = new BoundedQueue<number>(5)
    for (const n of [1, 2, 3, 4, 5]) {
      queue.push(n)
    }

    queue.filterInPlace(x => x % 2 === 1)
    expect(queue.length).toBe(3)
    expect([...queue]).toEqual([1, 3, 5])
  })
})
