import { flockItemCodec, flockSyncHooks } from './syncDomain'
import { getBlankGroup, getBlankPerson, type Item } from '../../state/items'
import type { ErrorItem } from '../../shared/schemas/items'
import type { ItemId } from '../../shared/vault/ids'

describe('flockItemCodec', () => {
  it('decodes a valid item', () => {
    const person = getBlankPerson('person-1' as ItemId, false)
    const decoded = flockItemCodec.decode(person.id, { ...person, name: 'Alice' }) as Item

    expect(decoded.type).toBe('person')
    expect(decoded.name).toBe('Alice')
    expect(flockItemCodec.isCorrupt(decoded)).toBe(false)
  })

  it('drops isNew from stored documents', () => {
    const person = getBlankPerson('person-1' as ItemId, true)
    const decoded = flockItemCodec.decode(person.id, person) as Item

    expect(decoded.isNew).toBeUndefined()
  })

  it('self-heals a topic containing leftover group fields', () => {
    const rawSnapshot = {
      id: 'converted-topic-1',
      type: 'topic',
      name: 'Global Topic',
      description: 'Formerly a group',
      created: 10000,
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
      members: ['member-1'],
      memberPrayerFrequency: 'daily',
      memberPrayerTarget: 'all',
    }

    const normalized = flockItemCodec.decode('converted-topic-1' as ItemId, rawSnapshot) as Item
    expect(normalized.type).toBe('topic')
    expect(normalized.name).toBe('Global Topic')
    expect((normalized as Record<string, unknown>).members).toBeUndefined()
    expect((normalized as Record<string, unknown>).memberPrayerFrequency).toBeUndefined()
    expect((normalized as Record<string, unknown>).memberPrayerTarget).toBeUndefined()
  })

  it('turns an unparseable document into a corrupt error item that keeps the raw snapshot', () => {
    const raw = { id: 'bad-1', type: 'group', name: 42 }
    const decoded = flockItemCodec.decode('bad-1' as ItemId, raw) as ErrorItem

    expect(decoded.type).toBe('error')
    expect(decoded.originalType).toBe('group')
    expect(decoded.rawSnapshot).toEqual(raw)
    expect(flockItemCodec.isCorrupt(decoded)).toBe(true)
  })

  it('reports the item type as the snapshot kind, using the original type for error items', () => {
    const group = getBlankGroup('group-1' as ItemId, false)
    expect(flockItemCodec.snapshotKind(group)).toBe('group')

    const corrupt = flockItemCodec.decode('bad-1' as ItemId, { id: 'bad-1', type: 'topic', name: 42 })
    expect(flockItemCodec.snapshotKind(corrupt)).toBe('topic')

    const unknown = flockItemCodec.decode('bad-2' as ItemId, { id: 'bad-2' })
    expect(flockItemCodec.snapshotKind(unknown)).toBe('person')
  })
})

describe('flockSyncHooks', () => {
  it('repoints group members from the old id to the new id', () => {
    const group = { ...getBlankGroup('group-1' as ItemId, false), members: ['old' as ItemId, 'other' as ItemId] }

    expect(flockSyncHooks.remapReferences!(group, 'old' as ItemId, 'new' as ItemId)).toEqual({
      members: ['new', 'other'],
    })
  })

  it('leaves items that do not reference the old id alone', () => {
    const group = { ...getBlankGroup('group-1' as ItemId, false), members: ['other' as ItemId] }
    const person = getBlankPerson('person-1' as ItemId, false)

    expect(flockSyncHooks.remapReferences!(group, 'old' as ItemId, 'new' as ItemId)).toBeNull()
    expect(flockSyncHooks.remapReferences!(person, 'old' as ItemId, 'new' as ItemId)).toBeNull()
  })

  it('resets the creation time of recreated items', () => {
    const person = { ...getBlankPerson('person-1' as ItemId, false), created: 1 }

    const recreated = flockSyncHooks.prepareRecreatedDoc!(person) as Item

    expect(recreated.created).toBeGreaterThan(1)
    expect(recreated.id).toBe('person-1')
  })
})
