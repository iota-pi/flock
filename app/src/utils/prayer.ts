import { frequencyToDays, frequencyToMilliseconds, isSameDay } from '.';
import { compareItems, Item } from '../state/items';

export function getLastPrayedFor(item: Item, excludeToday = false) {
  const prayedFor = (
    excludeToday ? item.prayedFor.filter(d => !isSameDay(new Date(d), new Date())) : item.prayedFor
  );
  return prayedFor[prayedFor.length - 1] || 0;
}

export function getPrayerSchedule(items: Item[]) {
  const withNextSchedule: [Item, number][] = items.map(
    item => [
      item,
      getLastPrayedFor(item, true) + frequencyToMilliseconds(item.prayerFrequency),
    ],
  );
  withNextSchedule.sort(
    (a, b) => (a[1] - b[1]) || compareItems(a[0], b[0]),
  );
  const itemsBySchedule = withNextSchedule.map(x => x[0]);
  return itemsBySchedule;
}

export function getNaturalPrayerGoal(items: Item[]) {
  const inverseFrequencies = items.map(item => 1 / frequencyToDays(item.prayerFrequency));
  const sum = inverseFrequencies.reduce((acc, x) => acc + x, 0);
  return Math.ceil(sum);
}
