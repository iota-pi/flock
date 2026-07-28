import type { Item } from '../state/items'
import { ITEM_TYPES } from '../shared/itemTypes'

export function mutateDraftToMatchSnapshot(
  draft: Record<string, any>,
  snapshot: Record<string, any>,
): void {
  for (const key of Object.keys(draft)) {
    if (!(key in snapshot) || snapshot[key] === undefined) {
      delete draft[key]
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      draft[key] = value
    }
  }
}

export function normalizeSnapshotType(type: Item['type'], originalType?: Item['type']): string {
  const resolvedType = (
    (type === 'error' && originalType) ? originalType : type
  )
  const isValidType = ITEM_TYPES.includes(resolvedType as (typeof ITEM_TYPES)[number])
  return isValidType
    ? resolvedType
    : 'person'
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
