import type { Item } from 'src/state/items'


export function diffItems(existing: Item, item: Item): string[] {
  const differences: string[] = []
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(item)])
  const ignoredKeys = new Set(['id', 'version', 'lastUpdated'])

  allKeys.forEach(key => {
    if (ignoredKeys.has(key)) return

    const val1 = (existing as unknown as Record<string, unknown>)[key]
    const val2 = (item as unknown as Record<string, unknown>)[key]

    if (Array.isArray(val1) && Array.isArray(val2)) {
      if (JSON.stringify([...val1].sort()) !== JSON.stringify([...val2].sort())) {
        differences.push(key)
      }
    } else if (val1 !== val2) {
      differences.push(key)
    }
  })

  return differences
}
