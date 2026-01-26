/**
 * Three-way merge:
 * - base: The common ancestor state
 * - theirs: The remote state (server)
 * - yours: The local state (client changes)
 *
 * Rules:
 * 1. If yours changed and theirs didn't -> use yours
 * 2. If theirs changed and yours didn't -> use theirs
 * 3. If both changed -> use yours (local wins conflict)
 */
function mergeArrays(base: unknown[] | null | undefined, theirs: unknown[], yours: unknown[]): unknown[] {
  const b = base || []
  const t = theirs || []
  const y = yours || []

  // If no base, simple union (order agnostic)
  if (!base) {
    const combined = [...t, ...y]
    // Deduplicate
    return combined.filter((item, index) => {
      const firstIndex = combined.findIndex(i => isEqual(i, item))
      return firstIndex === index
    })
  }

  // 3-way hash-based set merge
  // Calculate P (changes in yours relative to base)
  // Calculate Q (changes in theirs relative to base)
  // Result = Base + P + Q

  const hash = (item: unknown) => (
    typeof item === "string" ? item : JSON.stringify(item)
  )

  const baseSet = new Set(b.map(hash))
  const theirsSet = new Set(t.map(hash))
  const yoursSet = new Set(y.map(hash))

  const finalSet = new Set(baseSet)

  // Added
  y.forEach(item => {
    const h = hash(item)
    if (!baseSet.has(h)) finalSet.add(h)
  })
  t.forEach(item => {
    const h = hash(item)
    if (!baseSet.has(h)) finalSet.add(h)
  })

  // Removed
  b.forEach(item => {
    const h = hash(item)
    if (!yoursSet.has(h)) finalSet.delete(h)
    if (!theirsSet.has(h)) finalSet.delete(h)
  })

  // Reconstruct array
  const lookup = new Map<string, unknown>()
  const allSets = [...b, ...t, ...y]
  allSets.forEach(item => lookup.set(hash(item), item))

  return Array.from(finalSet).map(h => lookup.get(h))
}

export function threeWayMerge<T extends object>(base: T, theirs: T, yours: T): T {
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(theirs || {}),
    ...Object.keys(yours || {}),
  ])

  // Internal access helpers
  const bObj = (base || {}) as Record<string, unknown>
  const tObj = (theirs || {}) as Record<string, unknown>
  const yObj = (yours || {}) as Record<string, unknown>

  const result = {} as Record<string, unknown>

  for (const key of keys) {
    const b = bObj[key]
    const t = tObj[key]
    const y = yObj[key]

    if (Array.isArray(t) && Array.isArray(y)) {
      result[key] = mergeArrays(b as unknown[], t, y)
      continue
    }

    const yoursChanged = !isEqual(b, y)
    const theirsChanged = !isEqual(b, t)

    if (yoursChanged && !theirsChanged) {
      result[key] = y
    } else if (!yoursChanged && theirsChanged) {
      result[key] = t
    } else if (yoursChanged && theirsChanged) {
      // On conflict, local wins
      result[key] = y
    } else {
      // No changes
      result[key] = b
    }
  }

  return result as T
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false
    }
    return true
  }

  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!keysB.includes(key) || !isEqual(a[key], b[key])) return false
  }

  return true
}
