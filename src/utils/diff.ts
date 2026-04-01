import type { Item } from '../state/items'
import { deepEqual } from './deepCompare'

function isPrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
}

function areArraysEquivalent(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  if (left.every(isPrimitive) && right.every(isPrimitive)) {
    const normalizedLeft = left.map(value => String(value)).sort()
    const normalizedRight = right.map(value => String(value)).sort()
    return deepEqual(normalizedLeft, normalizedRight)
  }

  const consumedIndexes = new Set<number>()
  for (const leftValue of left) {
    let matchedIndex = -1
    for (let index = 0; index < right.length; index += 1) {
      if (consumedIndexes.has(index)) {
        continue
      }
      if (deepEqual(leftValue, right[index])) {
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

export function diffItems(existing: Item, item: Item): string[] {
  const differences: string[] = []
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(item)])
  const ignoredKeys = new Set(['id', 'version', 'lastUpdated'])

  allKeys.forEach(key => {
    if (ignoredKeys.has(key)) return

    const val1 = (existing as unknown as Record<string, unknown>)[key]
    const val2 = (item as unknown as Record<string, unknown>)[key]

    if (Array.isArray(val1) && Array.isArray(val2)) {
      if (!areArraysEquivalent(val1, val2)) {
        differences.push(key)
      }
    } else if (!deepEqual(val1, val2)) {
      differences.push(key)
    }
  })

  return differences
}
