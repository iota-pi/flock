import { differenceWith, isEqual, sortBy } from 'lodash-es'
import type { Item } from '../../../state/items'

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
}

function areArraysEquivalent(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  if (left.every(isPrimitive) && right.every(isPrimitive)) {
    const normalizedLeft = sortBy(left.map(value => String(value)))
    const normalizedRight = sortBy(right.map(value => String(value)))
    return isEqual(normalizedLeft, normalizedRight)
  }

  const consumedIndexes = new Set<number>()
  for (const leftValue of left) {
    let matchedIndex = -1
    for (let index = 0; index < right.length; index += 1) {
      if (consumedIndexes.has(index)) {
        continue
      }
      if (isEqual(leftValue, right[index])) {
        matchedIndex = index
        break
      }
    }

    if (matchedIndex === -1) {
      return false
    }

    consumedIndexes.add(matchedIndex)
  }

  return true
}

export function getItemDiffKeys(existing: Item, item: Item): string[] {
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(item)])
  const ignoredKeys = new Set(['id', 'version', 'lastUpdated'])

  const comparable = Array.from(allKeys)
    .filter(key => !ignoredKeys.has(key))
    .map(key => {
      const val1 = (existing as unknown as Record<string, unknown>)[key]
      const val2 = (item as unknown as Record<string, unknown>)[key]
      const equal = Array.isArray(val1) && Array.isArray(val2)
        ? areArraysEquivalent(val1, val2)
        : isEqual(val1, val2)

      return { key, equal }
    })

  const changed = differenceWith(
    comparable,
    comparable.filter(entry => entry.equal),
    (left, right) => left.key === right.key,
  )

  return changed.map(entry => entry.key)
}

export function hasItemDiff(existing: Item, item: Item): boolean {
  return getItemDiffKeys(existing, item).length > 0
}
