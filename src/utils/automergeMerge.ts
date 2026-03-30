function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(item => stripUndefinedDeep(item))
      .filter(item => item !== undefined)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (
    value instanceof Date
    || value instanceof Uint8Array
    || value instanceof ArrayBuffer
  ) {
    return value
  }

  const input = value as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(input)) {
    if (nested === undefined) {
      continue
    }
    cleaned[key] = stripUndefinedDeep(nested)
  }

  return cleaned
}

function isShallowJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function mergeWithAutomerge<T extends object>(
  left: T,
  right: T,
): Promise<T> {
  const Automerge = await import('@automerge/automerge')

  const leftDoc = Automerge.from(stripUndefinedDeep(left) as Record<string, unknown>)
  const rightDoc = Automerge.from(stripUndefinedDeep(right) as Record<string, unknown>)
  const merged = Automerge.merge(leftDoc, rightDoc)

  return Automerge.toJS(merged) as T
}

function applySnapshot(target: Record<string, unknown> | unknown[], snapshot: unknown): void {
  if (Array.isArray(snapshot)) {
    const targetArray = target as unknown[]
    targetArray.splice(0, targetArray.length)
    for (const value of snapshot) {
      if (Array.isArray(value)) {
        const nested: unknown[] = []
        applySnapshot(nested, value)
        targetArray.push(nested)
      } else if (value && typeof value === 'object') {
        const nested: Record<string, unknown> = {}
        applySnapshot(nested, value)
        targetArray.push(nested)
      } else {
        targetArray.push(value)
      }
    }
    return
  }

  if (!snapshot || typeof snapshot !== 'object') {
    return
  }

  const targetObject = target as Record<string, unknown>
  for (const key of Object.keys(targetObject)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      delete targetObject[key]
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) {
      if (Array.isArray(targetObject[key]) && isShallowJsonEqual(targetObject[key], value)) {
        continue
      }
      if (!Array.isArray(targetObject[key])) {
        targetObject[key] = []
      }
      applySnapshot(targetObject[key] as unknown[], value)
      continue
    }

    if (value && typeof value === 'object') {
      if (
        targetObject[key]
        && typeof targetObject[key] === 'object'
        && !Array.isArray(targetObject[key])
        && isShallowJsonEqual(targetObject[key], value)
      ) {
        continue
      }
      if (!targetObject[key] || typeof targetObject[key] !== 'object' || Array.isArray(targetObject[key])) {
        targetObject[key] = {}
      }
      applySnapshot(targetObject[key] as Record<string, unknown>, value)
      continue
    }

    if (targetObject[key] !== value) {
      targetObject[key] = value
    }
  }
}

export async function mergeFromBaseWithAutomerge<T extends object>(
  base: T | null | undefined,
  theirs: T,
  yours: T,
): Promise<T> {
  const Automerge = await import('@automerge/automerge')

  const baseSnapshot = stripUndefinedDeep(base || {}) as Record<string, unknown>
  const theirsSnapshot = stripUndefinedDeep(theirs) as Record<string, unknown>
  const yoursSnapshot = stripUndefinedDeep(yours) as Record<string, unknown>

  const baseDoc = Automerge.from(baseSnapshot)

  const theirsDoc = Automerge.change(Automerge.clone(baseDoc), doc => {
    applySnapshot(doc as unknown as Record<string, unknown>, theirsSnapshot)
  })

  const yoursDoc = Automerge.change(Automerge.clone(baseDoc), doc => {
    applySnapshot(doc as unknown as Record<string, unknown>, yoursSnapshot)
  })

  const merged = Automerge.merge(theirsDoc, yoursDoc)
  return Automerge.toJS(merged) as T
}
