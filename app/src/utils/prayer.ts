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
  const withNextSchedule: [Item, number][] = activeItems.map(
    item => [
      item,
      getLastPrayedFor(item, true) + frequencyToMilliseconds(item.prayerFrequency),
    ],
  )
  withNextSchedule.sort((a, b) => a[1] - b[1])
  const itemsBySchedule = withNextSchedule.map(x => x[0].id)
  return itemsBySchedule
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
