import { BoundedSet } from './BoundedSet'

describe('BoundedSet', () => {
  it('enforces positive finite maxCapacity in constructor', () => {
    expect(() => new BoundedSet(0)).toThrow(RangeError)
    expect(() => new BoundedSet(-1)).toThrow(RangeError)
    expect(() => new BoundedSet(NaN)).toThrow(RangeError)
    expect(() => new BoundedSet(Infinity)).toThrow(RangeError)
  })

  it('adds items, checks membership, and tracks size and maxCapacity', () => {
    const set = new BoundedSet<string>(3)
    expect(set.size).toBe(0)
    expect(set.maxCapacity).toBe(3)

    set.add('k1').add('k2')
    expect(set.size).toBe(2)
    expect(set.has('k1')).toBe(true)
    expect(set.has('k2')).toBe(true)
    expect(set.has('k3')).toBe(false)
  })

  it('evicts oldest element in FIFO order when adding beyond capacity', () => {
    const onEvict = vi.fn()
    const set = new BoundedSet<string>(3, { onEvict })

    set.add('a')
    set.add('b')
    set.add('c')
    expect(onEvict).not.toHaveBeenCalled()

    set.add('d')
    expect(set.size).toBe(3)
    expect(set.has('a')).toBe(false)
    expect(set.has('b')).toBe(true)
    expect(set.has('c')).toBe(true)
    expect(set.has('d')).toBe(true)
    expect(onEvict).toHaveBeenCalledWith('a')

    set.add('e')
    expect(onEvict).toHaveBeenCalledWith('b')
    expect([...set]).toEqual(['c', 'd', 'e'])
  })

  it('does not evict or change order when re-adding existing element', () => {
    const onEvict = vi.fn()
    const set = new BoundedSet<string>(3, onEvict)

    set.add('a')
    set.add('b')
    set.add('c')

    // Re-add 'a': already present, should be a no-op
    set.add('a')
    expect(set.size).toBe(3)
    expect(onEvict).not.toHaveBeenCalled()
    expect([...set]).toEqual(['a', 'b', 'c'])

    // Now adding 'd' should still evict 'a' as it remains the oldest inserted
    set.add('d')
    expect(onEvict).toHaveBeenCalledWith('a')
    expect([...set]).toEqual(['b', 'c', 'd'])
  })

  it('supports initialItems in options or as iterable constructor parameter', () => {
    const set1 = new BoundedSet<number>(2, { initialItems: [1, 2, 3] })
    expect([...set1]).toEqual([2, 3])

    const onEvict = vi.fn()
    const set2 = new BoundedSet<number>(2, [10, 20, 30], onEvict)
    expect([...set2]).toEqual([20, 30])
    expect(onEvict).toHaveBeenCalledWith(10)
  })

  it('deletes and clears elements', () => {
    const set = new BoundedSet<string>(3, ['x', 'y', 'z'])
    expect(set.delete('y')).toBe(true)
    expect(set.delete('nonexistent')).toBe(false)
    expect([...set]).toEqual(['x', 'z'])

    set.clear()
    expect(set.size).toBe(0)
    expect([...set]).toEqual([])
  })

  it('implements keys, values, entries, forEach, and iteration', () => {
    const set = new BoundedSet<number>(3, [1, 2])
    expect([...set.keys()]).toEqual([1, 2])
    expect([...set.values()]).toEqual([1, 2])
    expect([...set.entries()]).toEqual([[1, 1], [2, 2]])

    const visited: number[] = []
    set.forEach((v, k) => {
      expect(v).toBe(k)
      visited.push(v)
    })
    expect(visited).toEqual([1, 2])
  })
})
