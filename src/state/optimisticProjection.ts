import type { Item } from './items'
import type { QueuedMutation } from '../sync/offlineQueueStore'

type QueuePutPayload = {
  item?: string
  deleted?: boolean
} & Partial<Item>

type QueuePutManyPayload = {
  items?: Array<({ id?: string; deleted?: boolean } & Partial<Item>)>
}

type QueueDeletePayload = {
  item?: string
  id?: string
}

function upsertProjectedItem(items: Item[], projected: Item): Item[] {
  const index = items.findIndex(item => item.id === projected.id)
  if (index === -1) {
    return [...items, projected]
  }

  const next = [...items]
  next[index] = projected
  return next
}

export function projectOfflineMutations(baseItems: Item[], offlineQueue: QueuedMutation[]): Item[] {
  let projected = [...baseItems]

  for (const mutation of offlineQueue) {
    if (mutation.mutationType === 'items.put') {
      const payload = mutation.payload as QueuePutPayload
      const itemId = typeof payload.item === 'string' ? payload.item : undefined
      if (!itemId) {
        continue
      }

      if (payload.deleted === true) {
        projected = projected.filter(item => item.id !== itemId)
        continue
      }

      const current = projected.find(item => item.id === itemId)
      const merged = {
        ...(current || {}),
        ...payload,
        id: itemId,
      } as Item
      projected = upsertProjectedItem(projected, merged)
      continue
    }

    if (mutation.mutationType === 'items.putMany') {
      const payload = mutation.payload as QueuePutManyPayload
      const items = Array.isArray(payload.items) ? payload.items : []

      for (const queued of items) {
        const itemId = typeof queued.id === 'string' ? queued.id : undefined
        if (!itemId) {
          continue
        }

        if (queued.deleted === true) {
          projected = projected.filter(item => item.id !== itemId)
          continue
        }

        const current = projected.find(item => item.id === itemId)
        const merged = {
          ...(current || {}),
          ...queued,
          id: itemId,
        } as Item
        projected = upsertProjectedItem(projected, merged)
      }
      continue
    }

    if (mutation.mutationType === 'items.delete' || mutation.mutationType === 'items.remove') {
      const payload = mutation.payload as QueueDeletePayload
      const itemId = typeof payload.item === 'string'
        ? payload.item
        : (typeof payload.id === 'string' ? payload.id : undefined)
      if (!itemId) {
        continue
      }
      projected = projected.filter(item => item.id !== itemId)
    }
  }

  return projected
}
