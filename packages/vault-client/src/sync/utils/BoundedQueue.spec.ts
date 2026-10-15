import { BoundedQueue } from './BoundedQueue'

describe('BoundedQueue', () => {
  it('enforces positive finite maxCapacity in constructor', () => {
    expect(() => new BoundedQueue(0)).toThrow(RangeError)
    expect(() => new BoundedQueue(-5)).toThrow(RangeError)
    expect(() => new BoundedQueue(NaN)).toThrow(RangeError)
    expect(() => new BoundedQueue(Infinity)).toThrow(RangeError)
  })

  it('initializes empty and reports length/size and maxCapacity', () => {
    const queue = new BoundedQueue<number>(5)
    expect(queue.length).toBe(0)
    expect(queue.size).toBe(0)
    expect(queue.maxCapacity).toBe(5)
    expect(queue.peek()).toBeUndefined()
    expect(queue.peekLast()).toBeUndefined()
    expect(queue.shift()).toBeUndefined()
  })

  it('pushes and shifts items in FIFO order', () => {
    const queue = new BoundedQueue<string>(3)
    expect(queue.push('a')).toBe(1)
    expect(queue.push('b')).toBe(2)
    expect(queue.push('c')).toBe(3)

    expect(queue.peek()).toBe('a')
    expect(queue.peekLast()).toBe('c')
    expect(queue.length).toBe(3)

    expect(queue.shift()).toBe('a')
    expect(queue.shift()).toBe('b')
    expect(queue.shift()).toBe('c')
    expect(queue.shift()).toBeUndefined()
    expect(queue.length).toBe(0)
  })

  it('evicts oldest items when single pushes exceed capacity', () => {
    const onEvict = vi.fn()
    const onEvictBatch = vi.fn()
    const queue = new BoundedQueue<number>(3, { onEvict, onEvictBatch })

    queue.push(1)
    queue.push(2)
    queue.push(3)
    expect(onEvict).not.toHaveBeenCalled()

    // Push 4th item: should evict 1
    queue.push(4)
    expect(queue.length).toBe(3)
    expect(queue.toArray()).toEqual([2, 3, 4])
    expect(onEvict).toHaveBeenCalledWith(1)
    expect(onEvictBatch).toHaveBeenCalledWith([1])

    // Push 5th item: should evict 2
    queue.push(5)
    expect(queue.length).toBe(3)
    expect(queue.toArray()).toEqual([3, 4, 5])
    expect(onEvict).toHaveBeenCalledWith(2)
    expect(onEvictBatch).toHaveBeenCalledWith([2])
  })

  it('supports direct onEvict function as options argument', () => {
    const onEvict = vi.fn()
    const queue = new BoundedQueue<string>(2, onEvict)

    queue.push('x')
    queue.push('y')
    queue.push('z')

    expect(queue.toArray()).toEqual(['y', 'z'])
    expect(onEvict).toHaveBeenCalledWith('x')
  })

  it('handles batch push exceeding capacity correctly', () => {
    const onEvict = vi.fn()
    const onEvictBatch = vi.fn()
    const queue = new BoundedQueue<number>(3, { onEvict, onEvictBatch })

    queue.push(1, 2)
    expect(queue.length).toBe(2)

    // Push [3, 4, 5]: total would be 5, overflow is 2. Evicts 1 and 2
    queue.push(3, 4, 5)
    expect(queue.length).toBe(3)
    expect(queue.toArray()).toEqual([3, 4, 5])
    expect(onEvict).toHaveBeenCalledWith(1)
    expect(onEvict).toHaveBeenCalledWith(2)
    expect(onEvictBatch).toHaveBeenCalledWith([1, 2])
  })

  it('handles batch push where new items alone exceed capacity', () => {
    const onEvict = vi.fn()
    const onEvictBatch = vi.fn()
    const queue = new BoundedQueue<number>(3, { onEvict, onEvictBatch })

    queue.push(1, 2)
    // Push 5 new items: [10, 20, 30, 40, 50]
    // Total is 7, overflow is 4.
    // Evicts [1, 2] from existing, and [10, 20] from new items!
    queue.push(10, 20, 30, 40, 50)
    expect(queue.length).toBe(3)
    expect(queue.toArray()).toEqual([30, 40, 50])
    expect(onEvictBatch).toHaveBeenCalledWith([1, 2, 10, 20])
    expect(onEvict).toHaveBeenCalledTimes(4)
  })

  it('initializes with initialItems in options', () => {
    const queue = new BoundedQueue<number>(3, {
      initialItems: [1, 2, 3, 4, 5],
    })
    expect(queue.length).toBe(3)
    expect(queue.toArray()).toEqual([3, 4, 5])
  })

  it('clears and drains properly', () => {
    const queue = new BoundedQueue<string>(3, { initialItems: ['a', 'b', 'c'] })
    const drained = queue.drain()
    expect(drained).toEqual(['a', 'b', 'c'])
    expect(queue.length).toBe(0)

    queue.push('x', 'y')
    queue.clear()
    expect(queue.length).toBe(0)
    expect(queue.toArray()).toEqual([])
  })

  it('implements filter, returning a new BoundedQueue with same configuration', () => {
    const onEvict = vi.fn()
    const queue = new BoundedQueue<number>(5, {
      initialItems: [1, 2, 3, 4, 5],
      onEvict,
    })

    const filtered = queue.filter(x => x % 2 === 0)
    expect(filtered).toBeInstanceOf(BoundedQueue)
    expect(filtered.maxCapacity).toBe(5)
    expect(filtered.toArray()).toEqual([2, 4])

    // Filtered queue should inherit onEvict and capacity
    filtered.push(6, 8, 10, 12)
    expect(filtered.length).toBe(5)
    expect(onEvict).toHaveBeenCalledWith(2)
  })

  it('implements array methods: map, forEach, some, every, find and Iterable', () => {
    const queue = new BoundedQueue<number>(4, { initialItems: [10, 20, 30] })

    expect(queue.map(x => x * 2)).toEqual([20, 40, 60])

    const visited: number[] = []
    queue.forEach(x => visited.push(x))
    expect(visited).toEqual([10, 20, 30])

    expect(queue.some(x => x === 20)).toBe(true)
    expect(queue.some(x => x === 99)).toBe(false)
    expect(queue.every(x => x >= 10)).toBe(true)
    expect(queue.every(x => x > 10)).toBe(false)
    expect(queue.find(x => x > 15)).toBe(20)

    expect([...queue]).toEqual([10, 20, 30])
  })

  it('implements filterInPlace, mutating the queue in-place without reallocating', () => {
    const queue = new BoundedQueue<number>(5, {
      initialItems: [1, 2, 3, 4, 5],
    })

    const result = queue.filterInPlace(x => x % 2 === 1)
    expect(result).toBe(queue)
    expect(queue.length).toBe(3)
    expect(queue.toArray()).toEqual([1, 3, 5])
  })
})

