interface ObjectWithId {
  id: string | number
}

function hasId(item: unknown): item is ObjectWithId {
  return typeof item === 'object' && item !== null && 'id' in item
}

function mergeArraysById<T extends ObjectWithId>(base: T[] | null | undefined, theirs: T[], yours: T[]): T[] {
  const bList = (base || []).filter(hasId)
  const tList = theirs.filter(hasId)
  const yList = yours.filter(hasId)

  const baseMap = new Map(bList.map(i => [String(i.id), i]))
  const theirsMap = new Map(tList.map(i => [String(i.id), i]))
  const yoursMap = new Map(yList.map(i => [String(i.id), i]))

  const allIds = new Set([
    ...baseMap.keys(),
    ...theirsMap.keys(),
    ...yoursMap.keys(),
  ])

  const results: T[] = []

  for (const id of allIds) {
    const b = baseMap.get(id)
    const t = theirsMap.get(id)
    const y = yoursMap.get(id)

    // Exists in all 3 -> 3-way merge
    if (b && t && y) {
      results.push(threeWayMerge(b, t, y))
      continue
    }

    // New in theirs and yours -> 3-way merge (base is undefined)
    if (!b && t && y) {
      results.push(threeWayMerge(undefined, t, y))
      continue
    }

    // Deleted in yours?
    if (b && t && !y) {
      if (!isEqual(b, t)) {
        // Conflict: Remote modified, Local deleted.
        // Local wins -> Delete.
      }
      continue
    }

    // Deleted in theirs?
    if (b && !t && y) {
      if (!isEqual(b, y)) {
        // Conflict: Remote deleted, Local modified.
        // Local wins -> Keep.
        results.push(y)
      }
      continue
    }

    // Only in theirs (new) -> Keep
    if (!b && t && !y) {
      results.push(t)
      continue
    }

    // Only in yours (new) -> Keep
    if (!b && !t && y) {
      results.push(y)
      continue
    }
  }

  return results
}

function mergeArraysByHash<T>(base: T[] | null | undefined, theirs: T[], yours: T[]): T[] {
  const b = base || []
  const t = theirs || []
  const y = yours || []

  const hash = (item: T) => (
    typeof item === 'string' ? item : JSON.stringify(item)
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
  const lookup = new Map<string, T>()
  const allSets = [...b, ...t, ...y]
  allSets.forEach(item => lookup.set(hash(item), item))

  return Array.from(finalSet).map(h => lookup.get(h)!)
}

function mergeArrays<T>(base: T[] | null | undefined, theirs: T[], yours: T[]): T[] {
  if (
    base?.find(hasId)
    || theirs.find(hasId)
    || yours.find(hasId)
  ) {
    return mergeArraysById(
      base as ObjectWithId[] | null | undefined,
      theirs as ObjectWithId[],
      yours as ObjectWithId[],
    ) as unknown as T[]
  }

  return mergeArraysByHash(base, theirs, yours)
}

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
export function threeWayMerge<T extends object>(base: T | null | undefined, theirs: T, yours: T): T {
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(theirs || {}),
    ...Object.keys(yours || {}),
  ])

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

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const arrA = a as unknown[]
    const arrB = b as unknown[]
    if (arrA.length !== arrB.length) return false
    for (let i = 0; i < arrA.length; i++) {
      if (!isEqual(arrA[i], arrB[i])) return false
    }
    return true
  }

  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false

  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>

  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(objB, key)
      || !isEqual(objA[key], objB[key])
    ) return false
  }

  return true
}
