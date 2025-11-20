import {
  getBlankPerson,
  getBlankGroup,
  getBlankItem,
  supplyMissingAttributes,
  convertItem,
  isValid,
  checkProperties,
  importPeople,
  Item,
  GroupItem,
} from './items'

describe('items helpers', () => {
  it('creates blank person with defaults', () => {
    const p = getBlankPerson()
    expect(p.type).toBe('person')
    expect(p.prayerFrequency).toBe('none')
    expect(p.prayedFor).toBeDefined()
    expect(Array.isArray(p.prayedFor)).toBe(true)
    expect(p.isNew).toBe(true)
  })

  it('creates blank group with member defaults', () => {
    const g = getBlankGroup()
    expect(g.type).toBe('group')
    expect(Array.isArray(g.members)).toBe(true)
    expect(g.memberPrayerFrequency).toBe('none')
    expect(g.memberPrayerTarget).toBe('one')
  })

  it('getBlankItem returns correct type', () => {
    const p = getBlankItem('person')
    expect(p.type).toBe('person')
    const g = getBlankItem('group')
    expect(g.type).toBe('group')
  })

  it('supplyMissingAttributes fills defaults', () => {
    const partial = { id: 'x', type: 'person' } as unknown as Item
    const full = supplyMissingAttributes(partial)
    expect(full.name).toBeDefined()
    expect(full.prayerFrequency).toBeDefined()
    expect(full.id).toBe('x')
  })

  it('convertItem changes type and preserves id', () => {
    const person = getBlankPerson('person-1', false)
    person.name = 'Alice'
    const group = convertItem(person, 'group') as GroupItem
    expect(group.type).toBe('group')
    expect(group.id).toBe(person.id)
    expect(Array.isArray(group.members)).toBe(true)
  })

  it('isValid checks name presence', () => {
    const p = getBlankPerson()
    expect(isValid(p)).toBe(false)
    p.name = 'Bob'
    expect(isValid(p)).toBe(true)
  })

  it('checkProperties detects missing keys', () => {
    const bad = [{ id: '1', type: 'person' } as any]
    const res = checkProperties(bad)
    expect(res.error).toBe(true)
    expect(res.message).toContain('missing key')
    // good case
    const good = [supplyMissingAttributes({ id: '2', type: 'person' } as any)]
    const res2 = checkProperties(good)
    expect(res2.error).toBe(false)
  })

  it('importPeople builds group and adds people', () => {
    const data = [
      { name: 'Alice', description: 'd1', summary: 's1' },
      { name: 'Bob', description: 'd2', summary: 's2' },
      { name: 'Carrie', description: 'd3', summary: 's3' },
    ]
    const results = importPeople(data)
    expect(results.length).toEqual(data.length + 1)
    const group = results.find(i => i.type === 'group')
    expect(group?.type).toBe('group')
    const people = results.filter(i => i.type === 'person')
    expect(people.every(p => p.type === 'person')).toBe(true)
    expect(people.length).toEqual(data.length)
    // group members length matches
    expect((group as GroupItem).members.length).toBe(people.length)
  })
})
