import { compareItems, filterArchived, InteractionNote, PersonItem } from '../state/items';
import { Due, frequencyToMilliseconds, isDue } from './frequencies';


export function getInteractions(item: PersonItem): InteractionNote[] {
  return item.notes.filter(n => n.type === 'interaction') as InteractionNote[];
}

export function getLastInteraction(item: PersonItem): InteractionNote | undefined {
  const interactions = getInteractions(item);
  interactions.sort((a, b) => a.date - b.date);
  const lastInteraction = interactions[interactions.length - 1];
  return lastInteraction || undefined;
}

export function getLastInteractionDate(
  item: PersonItem,
  useItemCreatedAsFallback = false,
) {
  const lastInteraction = getLastInteraction(item);
  const fallback = useItemCreatedAsFallback ? item.created : 0;
  return lastInteraction?.date || fallback;
}

export function getInteractionSuggestions(items: PersonItem[]) {
  const activeItems = filterArchived(items);
  const dueItems = activeItems.filter(
    item => (
      isDue(
        new Date(getLastInteractionDate(item, true)),
        item.interactionFrequency,
      ) !== Due.fine
    ),
  );
  const withNextSchedule: [PersonItem, number][] = dueItems.map(
    item => [
      item,
      getLastInteractionDate(item, true) + frequencyToMilliseconds(item.interactionFrequency),
    ],
  );
  withNextSchedule.sort(
    (a, b) => (a[1] - b[1]) || compareItems(a[0], b[0]),
  );
  const itemsBySchedule = withNextSchedule.map(x => x[0]);
  return itemsBySchedule;
}
