import { describe, it, expect, vi } from 'vitest'
import { BoundedMap } from './BoundedMap'

describe('BoundedMap', () => {
  it('enforces positive finite maxCapacity in constructor', () => {
    expect(() => new BoundedMap(0)).toThrow(RangeError)
    expect(() => new BoundedMap(-10)).toThrow(RangeError)
    expect(() => new BoundedMap(NaN)).toThrow(RangeError)
    expect(() => new BoundedMap(Infinity)).toThrow(RangeError)
  })

  it('sets and gets entries and tracks size and maxCapacity', () => {
    const map = new BoundedMap<string, number>(3)
    expect(map.size).toBe(0)
    expect(map.maxCapacity).toBe(3)

    map.set('a', 1).set('b', 2)
    expect(map.size).toBe(2)
    expect(map.get('a')).toBe(1)
    expect(map.get('b')).toBe(2)
    expect(map.get('c')).toBeUndefined()
    expect(map.has('a')).toBe(true)
    expect(map.has('c')).toBe(false)
  })

  it('evicts oldest key-value entry in FIFO order when setting beyond capacity', () => {
    const onEvict = vi.fn()
    const map = new BoundedMap<string, number>(3, { onEvict })

    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3)
    expect(onEvict).not.toHaveBeenCalled()

    // Add 4th entry: should evict 'a'
    map.set('d', 4)
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(false)
    expect(map.get('a')).toBeUndefined()
    expect(map.get('d')).toBe(4)
    expect(onEvict).toHaveBeenCalledWith('a', 1)

    // Add 5th entry: should evict 'b'
    map.set('e', 5)
    expect(onEvict).toHaveBeenCalledWith('b', 2)
    expect([...map.keys()]).toEqual(['c', 'd', 'e'])
  })

  it('updates existing key without evicting or changing FIFO insertion order', () => {
    const onEvict = vi.fn()
    const map = new BoundedMap<string, number>(3, onEvict)

    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3)

    // Update existing key 'a'
    map.set('a', 100)
    expect(map.size).toBe(3)
    expect(map.get('a')).toBe(100)
    expect(onEvict).not.toHaveBeenCalled()
    expect([...map.keys()]).toEqual(['a', 'b', 'c'])

    // Inserting new entry 'd' should still evict 'a' (oldest inserted)
    map.set('d', 4)
    expect(onEvict).toHaveBeenCalledWith('a', 100)
    expect([...map.keys()]).toEqual(['b', 'c', 'd'])
  })

  it('supports initialEntries in options or as iterable constructor parameter', () => {
    const map1 = new BoundedMap<string, number>(2, {
      initialEntries: [
        ['k1', 1],
        ['k2', 2],
        ['k3', 3],
      ],
    })
    expect([...map1.entries()]).toEqual([
      ['k2', 2],
      ['k3', 3],
    ])

    const onEvict = vi.fn()
    const map2 = new BoundedMap<string, number>(
      2,
      [
        ['a', 10],
        ['b', 20],
        ['c', 30],
      ],
      onEvict
    )
    expect([...map2.entries()]).toEqual([
      ['b', 20],
      ['c', 30],
    ])
    expect(onEvict).toHaveBeenCalledWith('a', 10)
  })

  it('deletes and clears entries', () => {
    const map = new BoundedMap<string, number>(3, [
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ])
    expect(map.delete('y')).toBe(true)
    expect(map.delete('nonexistent')).toBe(false)
    expect([...map.keys()]).toEqual(['x', 'z'])

    map.clear()
    expect(map.size).toBe(0)
    expect(map.get('x')).toBeUndefined()
  })

  it('implements keys, values, entries, forEach, and iteration', () => {
    const map = new BoundedMap<string, number>(3, [
      ['p', 1],
      ['q', 2],
    ])
    expect([...map.keys()]).toEqual(['p', 'q'])
    expect([...map.values()]).toEqual([1, 2])
    expect([...map.entries()]).toEqual([
      ['p', 1],
      ['q', 2],
    ])

    const visited: Array<[string, number]> = []
    map.forEach((v, k) => visited.push([k, v]))
    expect(visited).toEqual([
      ['p', 1],
      ['q', 2],
    ])

    expect([...map]).toEqual([
      ['p', 1],
      ['q', 2],
    ])
  })
})
