import { Item } from '../state/items';


export function getInteractions(item: Item) {
  return item.notes.filter(n => n.type === 'interaction');
}

export function getLastInteraction(item: Item) {
  const interactions = getInteractions(item);
  interactions.sort((a, b) => a.date - b.date);
  const lastInteraction = interactions[interactions.length - 1];
  return lastInteraction || undefined;
}
