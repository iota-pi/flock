import { isSameDay } from '.'
import { frequencyToDays, frequencyToMilliseconds } from './frequencies'
import { compareItems, filterArchived, Item } from '../state/items'
import type { GroupItem } from '../state/items'

function getGroups(items: Item[]): GroupItem[] {
  return items.filter((i): i is GroupItem => i.type === 'group')
}

export function buildPrayerFreqMap(items: Item[]): Map<string, number> {
  const groups = getGroups(items)

  const map: Map<string, number> = new Map()

  // Initialise map with each person's own set frequency
  for (const it of items) {
    if (it.type === 'person' && it.prayerFrequency && it.prayerFrequency !== 'none') {
      map.set(it.id, frequencyToDays(it.prayerFrequency))
    }
  }

  // Iterate through groups and apply memberPrayerFrequency to members
  for (const g of groups) {
    if (g.memberPrayerFrequency && g.memberPrayerFrequency !== 'none') {
      const groupDays = frequencyToDays(g.memberPrayerFrequency)
      const effectiveGroupDays = (
        g.memberPrayerTarget === 'one'
          ? groupDays * g.members.length
          : groupDays
      )
      for (const memberId of g.members) {
        const currDays = map.get(memberId)
        if (currDays === undefined) {
          map.set(memberId, effectiveGroupDays)
        } else if (effectiveGroupDays < currDays) {
          map.set(memberId, effectiveGroupDays)
        }
      }
    }
  }

  return map
}

export function getActiveItems(
  items: Item[],
  frequencies?: Map<string, number>,
): Item[] {
  const freqMap = frequencies ?? buildPrayerFreqMap(items)
  return items.filter(i => freqMap.has(i.id)).sort(compareItems)
}

export function getLastPrayedFor(
  item: Item,
  excludeToday = false,
) {
  const prayedFor = (
    excludeToday ? item.prayedFor.filter(d => !isSameDay(new Date(d), new Date())) : item.prayedFor
  )
  return prayedFor[prayedFor.length - 1] || 0
}

export function getPrayerSchedule(items: Item[]): string[] {
  const unarchived = filterArchived(items)
  const freqMap = buildPrayerFreqMap(unarchived)
  const activeItems = getActiveItems(unarchived, freqMap)

  // 1. Pre-calculate next due date and shift quantum for each item
  const candidates = activeItems.map(item => {
    const last = getLastPrayedFor(item, true)
    const interval = frequencyToMilliseconds(freqMap.get(item.id)!)

    // Determine group properties
    let groupId = item.id // Default to self as group if no group found
    let groupShiftQuantum = 0

    // Find groups this item belongs to
    const groups = unarchived.filter((g): g is GroupItem =>
      g.type === 'group' && g.members.includes(item.id)
    )

    if (groups.length > 0) {
      // Select best group: Higher frequency (lower interval) wins.
      // Tie-breaker: Fewer members wins.
      const bestGroup = groups.reduce((best, curr) => {
        const bestFreq = frequencyToMilliseconds(best.memberPrayerFrequency)
        const currFreq = frequencyToMilliseconds(curr.memberPrayerFrequency)
        if (currFreq < bestFreq) return curr
        if (currFreq === bestFreq) {
          return (curr.members.length < best.members.length) ? curr : best
        }
        return best
      })

      groupId = bestGroup.id
      const memberCount = bestGroup.members.length || 1
      const groupFreqMs = frequencyToMilliseconds(bestGroup.memberPrayerFrequency)

      // Quantum calculation based on target
      if (bestGroup.memberPrayerTarget === 'one') {
        groupShiftQuantum = groupFreqMs
      } else {
        groupShiftQuantum = groupFreqMs / memberCount
      }
    }

    return {
      id: item.id,
      groupId,
      groupShiftQuantum,
      next: last + interval,
      originalItem: item,
    }
  })

  const schedule: string[] = []
  const groupCounts: Record<string, number> = {}

  // 2. Iterative Selection
  while (candidates.length > 0) {
    // Sort by effective urgency:
    // How long ago was effectiveNext?
    // (effectiveNext = next + (groupCount * quantum)
    candidates.sort((a, b) => {
      const countA = groupCounts[a.groupId] || 0
      const countB = groupCounts[b.groupId] || 0

      const effectiveNextA = a.next + (countA * a.groupShiftQuantum)
      const effectiveNextB = b.next + (countB * b.groupShiftQuantum)

      // We want the item whose effectiveNext is smallest (earliest in time), i.e. most overdue relative to now
      return effectiveNextA - effectiveNextB
    })

    // Pick top
    const top = candidates[0]
    schedule.push(top.id)

    // Update group counts
    groupCounts[top.groupId] = (groupCounts[top.groupId] || 0) + 1

    // Remove from candidates
    candidates.shift()
  }

  return schedule
}

export function getNaturalPrayerGoal(items: Item[]) {
  const unarchived = filterArchived(items)
  const freqMap = buildPrayerFreqMap(unarchived)
  const activeItems = getActiveItems(unarchived, freqMap)

  let sum = 0
  for (const item of activeItems) {
    const days = freqMap.get(item.id)!
    sum += 1 / days
  }

  return Math.ceil(sum)
}

export function filterNoTarget(items: Item[]) {
  return items.filter(item => item.prayerFrequency !== 'none')
}
