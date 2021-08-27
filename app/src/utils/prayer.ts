import { isSameDay } from '.';
import { frequencyToDays, frequencyToMilliseconds } from './frequencies';
import { compareItems, filterArchived, Item, PrayerNote } from '../state/items';

export function getPrayerPoints(item: Item): PrayerNote[] {
  return item.notes.filter(n => n.type === 'prayer') as PrayerNote[];
}

export function getLastPrayedFor(
  item: Item,
  excludeToday = false,
  useItemCreatedAsFallback = false,
) {
  const prayedFor = (
    excludeToday ? item.prayedFor.filter(d => !isSameDay(new Date(d), new Date())) : item.prayedFor
  );
  const fallback = useItemCreatedAsFallback ? item.created : 0;
  return prayedFor[prayedFor.length - 1] || fallback;
}

export function getPrayerSchedule(items: Item[]) {
  const activeItems = filterArchived(items);
  const withNextSchedule: [Item, number, boolean][] = activeItems.map(
    item => [
      item,
      getLastPrayedFor(item, true) + frequencyToMilliseconds(item.prayerFrequency),
      isSameDay(new Date(), new Date(item.prayedFor[item.prayedFor.length - 1])),
    ],
  );
  withNextSchedule.sort(
    (a, b) => (+b[2] - +a[2]) || (a[1] - b[1]) || compareItems(a[0], b[0]),
  );
  const itemsBySchedule = withNextSchedule.map(x => x[0]);
  return itemsBySchedule;
}

export function getNaturalPrayerGoal(items: Item[]) {
  const activeItems = filterArchived(items);
  const inverseFrequencies = activeItems.map(item => 1 / frequencyToDays(item.prayerFrequency));
  const sum = inverseFrequencies.reduce((acc, x) => acc + x, 0);
  return Math.ceil(sum);
}
