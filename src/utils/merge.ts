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
