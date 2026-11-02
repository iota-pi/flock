import { BoundedSet } from './BoundedSet'

describe('BoundedSet', () => {
  it('evicts the oldest value when adding a new value beyond capacity', () => {
    const set = new BoundedSet<string>(3)
    set.add('a').add('b').add('c')

    set.add('d')
    expect(set.has('a')).toBe(false)
    expect([...set]).toEqual(['b', 'c', 'd'])
  })

  it('does not evict or reorder when re-adding an existing value', () => {
    const set = new BoundedSet<string>(3)
    set.add('a').add('b').add('c')

    set.add('a')
    expect([...set]).toEqual(['a', 'b', 'c'])

    set.add('d')
    expect([...set]).toEqual(['b', 'c', 'd'])
  })

  it('makes room again after a delete', () => {
    const set = new BoundedSet<string>(2)
    set.add('a').add('b')
    set.delete('a')

    set.add('c')
    expect([...set]).toEqual(['b', 'c'])
  })
})
