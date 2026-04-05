import type { Item } from '../state/items'

export function optimisticStoreItemsUpdate(oldItems: Item[] | undefined, incomingItems: Item[]): Item[] {
  const baseItems = oldItems || []
  const deletedIds = new Set(
    incomingItems
      .filter(item => item.deleted === true)
      .map(item => item.id),
  )

  const incoming = incomingItems.filter(item => item.deleted !== true)

  const nextItems = baseItems.filter(item => !deletedIds.has(item.id))
  if (nextItems.length === 0 && incoming.length === 0) {
    return []
  }

  for (const item of incoming) {
    const index = nextItems.findIndex(existing => existing.id === item.id)
    if (index >= 0) {
      nextItems[index] = item
    } else {
      nextItems.push(item)
    }
  }

  return nextItems
}