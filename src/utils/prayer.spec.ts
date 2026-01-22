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
    version: 1,
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
    version: 1,
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

  it('should spread group members when multiple are overdue', () => {
    // Setup: Two groups, G1 and G2. 3 members each.
    // G1 members: A1, A2, A3
    // G2 members: B1, B2, B3
    // Both groups "daily". All members never prayed for (very overdue).

    const A1 = makePerson('A1', 'none')
    const A2 = makePerson('A2', 'none')
    const A3 = makePerson('A3', 'none')
    const G1 = makeGroup('G1', ['A1', 'A2', 'A3'], 'daily')

    const B1 = makePerson('B1', 'none')
    const B2 = makePerson('B2', 'none')
    const B3 = makePerson('B3', 'none')
    const G2 = makeGroup('G2', ['B1', 'B2', 'B3'], 'daily')

    // Scrambled input order
    const items = [A1, A2, B1, G1, B2, A3, G2, B3]

    const schedule = getPrayerSchedule(items)

    expect(schedule.length).toBe(6)

    // Check that we have exactly 2 As and 2 Bs in the first 4 items
    // This proves they are interleaved (or at least not clumped as AAA or BBB)
    expect(schedule.slice(0, 4).filter(id => id.startsWith('A')).length).toBe(2)
  })

  it('should shift by full frequency when target is "one"', () => {
    // Group G1: Weekly, 3 Members, Target One.
    // A1/A2 Last Prayed: 70 days ago (10 weeks).
    // A1 Next Due: 63 days ago (9 weeks).
    // A2 Effective Next: 56 days ago (8 weeks) [Shifted by 1 week].

    // Competing Item C1: Weekly.
    // We want C1 Next to be between 63 and 56 days ago (e.g. 60 days ago).
    // C1 Last Prayed: 67 days ago (60 + 7).

    // Result order should be: A1 (-63d), C1 (-60d), A2 (-56d).

    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000
    // A interval is 14 days (Weekly * 2 members)
    // We want A Next = T - 63d. So Last = T - 63 - 14 = T - 77d.
    const aLast = now - 77 * oneDay
    const cLast = now - 67 * oneDay

    const A1 = makePerson('A1', 'none', [aLast])
    const A2 = makePerson('A2', 'none', [aLast])
    const G1 = makeGroup('G1', ['A1', 'A2'], 'weekly', 'one')

    const C1 = makePerson('C1', 'weekly', [cLast])

    const items = [A1, A2, C1, G1]
    const schedule = getPrayerSchedule(items)

    expect(schedule).toEqual(['A1', 'C1', 'A2'])
  })
})
