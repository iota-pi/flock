import { isSameDay } from '.'
import { frequencyToDays, frequencyToMilliseconds } from './frequencies'
import { compareItems, filterArchived, Item } from '../state/items'
import type { GroupItem } from '../state/items'

function getGroups(items: Item[]): GroupItem[] {
  return items.filter((i): i is GroupItem => i.type === 'group')
}

function buildPrayerFreqMap(items: Item[]): Map<string, number> {
  const unarchived = filterArchived(items)
  const groups = getGroups(unarchived)

  const map: Map<string, number> = new Map()

  // Initialise map with each person's own frequency (as days)
  for (const it of unarchived) {
    if (it.type === 'person' && it.prayerFrequency && it.prayerFrequency !== 'none') {
      map.set(it.id, frequencyToDays(it.prayerFrequency))
    }
  }

  // Iterate groups once and apply memberPrayerFrequency (as days) for groups targeting members
  for (const g of groups) {
    if (g.memberPrayerFrequency && g.memberPrayerFrequency !== 'none') {
      const groupDays = frequencyToDays(g.memberPrayerFrequency)
      const effectiveGroupDays = g.memberPrayerTarget === 'one' ? groupDays : groupDays / g.members.length
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

export function getActiveItems(items: Item[]): Item[] {
  const unarchived = filterArchived(items)
  const freqMap = buildPrayerFreqMap(items)
  return unarchived.filter(i => freqMap.has(i.id)).sort(compareItems)
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
  const activeItems = getActiveItems(items)
  const freqMap = buildPrayerFreqMap(items)
  const now = Date.now()
  const itemsWithSortInfo = activeItems.map(
    item => {
      const last = getLastPrayedFor(item, true)
      const interval = frequencyToMilliseconds(freqMap.get(item.id)!)

      return {
        item,
        next: last + interval,
        missed: Math.floor((now - last) / interval),
      }
    },
  )
  itemsWithSortInfo.sort(
    (a, b) => (b.missed - a.missed) || (a.next - b.next)
  )
  return itemsWithSortInfo.map(x => x.item.id)
}

export function getNaturalPrayerGoal(items: Item[]) {
  const freqMap = buildPrayerFreqMap(items)
  const activeItems = getActiveItems(items)

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
