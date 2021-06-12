import { frequencyToDays, frequencyToMilliseconds } from '.';
import { Item } from '../state/items';

export function getPrayerSchedule(items: Item[]) {
  const withNextSchedule: [Item, number][] = items.map(
    item => [item, (item.lastPrayedFor || 0) + frequencyToMilliseconds(item.prayerFrequency)],
  );
  withNextSchedule.sort(
    (a, b) => a[1] - b[1],
  );
  const itemsBySchedule = withNextSchedule.map(x => x[0]);
  return itemsBySchedule;
}

export function getNaturalPrayerGoal(items: Item[]) {
  const inverseFrequencies = items.map(item => 1 / frequencyToDays(item.prayerFrequency));
  const sum = inverseFrequencies.reduce((acc, x) => acc + x, 0);
  return Math.ceil(sum);
}
