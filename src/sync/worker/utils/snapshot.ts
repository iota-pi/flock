import { ITEM_TYPES } from 'src/shared/schemas/items'
import type { Item } from 'src/state/items'

export function mutateDraftToMatchSnapshot<T>(
  draft: Record<string, T>,
  snapshot: Record<string, T>,
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
