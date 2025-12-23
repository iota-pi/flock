import {
  buildPrayerFreqMap,
  getActiveItems,
  getPrayerSchedule,
  getNaturalPrayerGoal,
} from './prayer'
import type { Item, GroupItem } from '../state/items'

function makePerson(id: string, prayerFrequency: Item['prayerFrequency'], prayedFor: number[] = []): Item {
  return {
    id,
    archived: false,
    created: Date.now(),
    description: '',
    name: id,
    prayedFor,
    prayerFrequency,
    summary: '',
    type: 'person',
  }
}

function makeGroup(
  id: string,
  members: string[],
  memberPrayerFrequency: GroupItem['memberPrayerFrequency'],
  memberPrayerTarget: GroupItem['memberPrayerTarget'] = 'all',
): GroupItem {
  return {
    id,
    archived: false,
    created: Date.now(),
    description: '',
    name: id,
    prayedFor: [],
    prayerFrequency: 'none',
    summary: '',
    type: 'group',
    members,
    memberPrayerFrequency,
    memberPrayerTarget,
  }
}

describe('prayer utilities', () => {
  it('builds effective frequency map including group member frequencies', () => {
    const p1 = makePerson('p1', 'none')
    const p2 = makePerson('p2', 'daily')
    const p3 = makePerson('p3', 'none')
    const g1 = makeGroup('g1', ['p1', 'p2', 'p3'], 'weekly', 'one')

    let items: Item[] = [p1, p2, p3, g1]
    let map = buildPrayerFreqMap(items)

    expect(map.get('p1')).toBeCloseTo(21)
    expect(map.get('p2')).toBeCloseTo(1)
    expect(map.get('p3')).toBeCloseTo(21)

    const g2 = makeGroup('g2', ['p1', 'p2', 'p3'], 'weekly', 'all')
    items = [...items, g2]
    map = buildPrayerFreqMap(items)

    expect(map.get('p1')).toBeCloseTo(7)
    expect(map.get('p2')).toBeCloseTo(1)
    expect(map.get('p3')).toBeCloseTo(7)
  })

  it('includes persons covered by groups in active items and schedules them correctly', () => {
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000

    // p1: covered by weekly group, last prayed 20 days ago
    const p1 = makePerson('p1', 'none', [now - (20 * oneDay)])
    // p2: daily, last prayed 1 day ago
    const p2 = makePerson('p2', 'daily', [now - (1 * oneDay)])
    const g1 = makeGroup('g1', ['p1'], 'weekly', 'all')

    const items: Item[] = [p1, p2, g1]

    const active = getActiveItems(items)
    // both persons should be active
    const ids = active.map(i => i.id)
    expect(ids).toContain('p1')
    expect(ids).toContain('p2')

    const schedule = getPrayerSchedule(items)
    // p1 (missed more) should come before p2
    expect(schedule[0]).toBe('p1')
    expect(schedule[1]).toBe('p2')
  })

  it('computes natural prayer goal from effective frequencies', () => {
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000

    const p1 = makePerson('p1', 'none', [now - (20 * oneDay)])
    const p2 = makePerson('p2', 'daily', [now - (1 * oneDay)])
    const g1 = makeGroup('g1', ['p1'], 'weekly', 'all')

    const items: Item[] = [p1, p2, g1]
    const goal = getNaturalPrayerGoal(items)

    // person contributions: 1/1 + 1/7 = ~1.1428 => ceil = 2
    expect(goal).toBe(2)
  })

  it('calculates correct goal for groups targeting "one" member', () => {
    // Group: Daily, 3 members, target "One"
    // Intent: Pray for 1 member of this group every day.
    // Goal contribution should be 1.
    const p1 = makePerson('p1', 'none')
    const p2 = makePerson('p2', 'none')
    const p3 = makePerson('p3', 'none')
    const g1 = makeGroup('g1', ['p1', 'p2', 'p3'], 'daily', 'one')

    const items: Item[] = [p1, p2, p3, g1]
    const goal = getNaturalPrayerGoal(items)

    expect(goal).toBe(1)
  })

  it('calculates correct goal for groups targeting "all" members', () => {
    // Group: Daily, 3 members, target "All"
    // Intent: Pray for ALL members of this group every day.
    // Goal contribution should be 3.
    const p1 = makePerson('p1', 'none')
    const p2 = makePerson('p2', 'none')
    const p3 = makePerson('p3', 'none')
    const g1 = makeGroup('g1', ['p1', 'p2', 'p3'], 'daily', 'all')

    const items: Item[] = [p1, p2, p3, g1]
    const goal = getNaturalPrayerGoal(items)

    expect(goal).toBe(3)
  })
})
