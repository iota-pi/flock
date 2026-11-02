import { BoundedMap } from './BoundedMap'

describe('BoundedMap', () => {
  it('evicts the oldest entry when setting a new key beyond capacity', () => {
    const map = new BoundedMap<string, number>(3)
    map.set('a', 1).set('b', 2).set('c', 3)

    map.set('d', 4)
    expect(map.has('a')).toBe(false)
    expect([...map]).toEqual([
      ['b', 2],
      ['c', 3],
      ['d', 4],
    ])
  })

  it('updates an existing key without evicting or changing its position', () => {
    const map = new BoundedMap<string, number>(3)
    map.set('a', 1).set('b', 2).set('c', 3)

    map.set('a', 100)
    expect(map.size).toBe(3)
    expect([...map.keys()]).toEqual(['a', 'b', 'c'])

    map.set('d', 4)
    expect([...map.keys()]).toEqual(['b', 'c', 'd'])
  })

  it('makes room again after a delete', () => {
    const map = new BoundedMap<string, number>(2)
    map.set('a', 1).set('b', 2)
    map.delete('a')

    map.set('c', 3)
    expect([...map.keys()]).toEqual(['b', 'c'])
  })
})
