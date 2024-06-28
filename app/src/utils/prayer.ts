import { isSameDay } from '.'
import { frequencyToDays, frequencyToMilliseconds } from './frequencies'
import { compareItems, filterArchived, Item } from '../state/items'

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
  const activeItems = filterNoTarget(filterArchived(items)).sort(compareItems)
  const now = Date.now()
  const itemsWithSortInfo = activeItems.map(
    item => {
      const last = getLastPrayedFor(item, true)
      const interval = frequencyToMilliseconds(item.prayerFrequency)
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
  const activeItems = filterArchived(items)
  const inverseFrequencies = activeItems.map(item => 1 / frequencyToDays(item.prayerFrequency))
  const sum = inverseFrequencies.reduce((acc, x) => acc + x, 0)
  return Math.ceil(sum)
}

export function filterNoTarget(items: Item[]) {
  return items.filter(item => item.prayerFrequency !== 'none')
}
