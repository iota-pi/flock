import { WalEntryQuery, type WalEntryDescriptor } from './WalEntryQuery'

describe('WalEntryQuery', () => {
  interface TestEntry extends WalEntryDescriptor {
    label: string
  }

  const entry1: TestEntry = { id: 'e1', createdAt: 100, seq: 1, label: 'Entry 1' }
  const entry2: TestEntry = { id: 'e2', createdAt: 200, seq: 2, label: 'Entry 2' }
  const entry3: TestEntry = { id: 'e3', createdAt: 200, seq: 3, label: 'Entry 3' }
  const entry4: TestEntry = { id: 'e4', createdAt: 300, seq: 4, label: 'Entry 4' }
  const allEntries = [entry1, entry2, entry3, entry4]

  it('handles empty entries gracefully', () => {
    const query = new WalEntryQuery([], new Set(['e1']))
    expect(query.totalCount).toBe(0)
    expect(query.available()).toEqual([])
    expect(query.inFlight()).toEqual([])
    expect(query.superseded(new Set(['e1']))).toEqual([])
    expect(query.valid(new Set(['e1']))).toEqual([])
    expect(query.validSorted(new Set())).toEqual([])
    expect(query.availableSorted()).toEqual([])
  })

  it('returns all entries as available when no entries are in-flight', () => {
    const query = new WalEntryQuery(allEntries, new Set())
    expect(query.totalCount).toBe(4)
    expect(query.available()).toEqual(allEntries)
    expect(query.inFlight()).toEqual([])
  })

  it('filters available vs in-flight entries correctly', () => {
    const inFlightIds = new Set(['e2', 'e3'])
    const query = new WalEntryQuery(allEntries, inFlightIds)

    expect(query.available().map(e => e.id)).toEqual(['e1', 'e4'])
    expect(query.inFlight().map(e => e.id)).toEqual(['e2', 'e3'])
  })

  it('filters superseded entries while strictly excluding in-flight entries', () => {
    // e2 is in-flight and also in supersededIds
    // e1 is superseded and NOT in-flight
    // e3 and e4 are valid
    const inFlightIds = new Set(['e2'])
    const supersededIds = new Set(['e1', 'e2'])

    const query = new WalEntryQuery(allEntries, inFlightIds)
    const superseded = query.superseded(supersededIds)

    // e2 should NOT be included because it is in-flight
    expect(superseded.map(e => e.id)).toEqual(['e1'])
  })

  it('filters valid entries while strictly excluding both superseded and in-flight entries', () => {
    // e1 is superseded
    // e2 is in-flight
    // e3 and e4 are available and valid
    const inFlightIds = new Set(['e2'])
    const supersededIds = new Set(['e1'])

    const query = new WalEntryQuery(allEntries, inFlightIds)
    const valid = query.valid(supersededIds)

    expect(valid.map(e => e.id)).toEqual(['e3', 'e4'])
  })

  it('sorts valid entries chronologically with seq tie-breaking in validSorted', () => {
    const scrambledEntries: TestEntry[] = [
      { id: 'b2', createdAt: 200, seq: 2, label: 'b2' },
      { id: 'c1', createdAt: 300, seq: 1, label: 'c1' },
      { id: 'a1', createdAt: 100, seq: 1, label: 'a1' },
      { id: 'b1', createdAt: 200, seq: 1, label: 'b1' },
    ]

    const query = new WalEntryQuery(scrambledEntries, new Set(['c1']))
    const sorted = query.validSorted(new Set())

    expect(sorted.map(e => e.id)).toEqual(['a1', 'b1', 'b2'])
  })

  it('sorts available entries chronologically in availableSorted', () => {
    const scrambledEntries: TestEntry[] = [
      { id: 'e3', createdAt: 300, seq: 1, label: '3' },
      { id: 'e1', createdAt: 100, seq: 1, label: '1' },
      { id: 'e2', createdAt: 200, seq: 1, label: '2' },
    ]

    const query = new WalEntryQuery(scrambledEntries, new Set(['e2']))
    const sorted = query.availableSorted()

    expect(sorted.map(e => e.id)).toEqual(['e1', 'e3'])
  })

  it('handles missing or undefined createdAt and seq gracefully during sorting', () => {
    const entries: WalEntryDescriptor[] = [
      { id: 'x', createdAt: 100 },
      { id: 'y' }, // createdAt and seq undefined
      { id: 'z', createdAt: 50 },
    ]

    const sorted = WalEntryQuery.sortByAge(entries)
    expect(sorted.map(e => e.id)).toEqual(['y', 'z', 'x'])
  })

  it('does not mutate original entries array during sorting', () => {
    const original: TestEntry[] = [
      { id: 'b', createdAt: 200, label: 'b' },
      { id: 'a', createdAt: 100, label: 'a' },
    ]
    const copy = [...original]

    WalEntryQuery.sortByAge(original)
    expect(original).toEqual(copy)
  })
})
