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

function applySnapshot(target: any, snapshot: any): void {
  if (Array.isArray(snapshot)) {
    target.splice(0, target.length)
    for (const value of snapshot) {
      if (Array.isArray(value)) {
        const nested: unknown[] = []
        applySnapshot(nested, value)
        target.push(nested)
      } else if (value && typeof value === 'object') {
        const nested: Record<string, unknown> = {}
        applySnapshot(nested, value)
        target.push(nested)
      } else {
        target.push(value)
      }
    }
    return
  }

  if (!snapshot || typeof snapshot !== 'object') {
    return
  }

  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      delete target[key]
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (Array.isArray(value)) {
      if (Array.isArray(target[key]) && JSON.stringify(target[key]) === JSON.stringify(value)) {
        continue
      }
      if (!Array.isArray(target[key])) {
        target[key] = []
      }
      applySnapshot(target[key], value)
      continue
    }

    if (value && typeof value === 'object') {
      if (
        target[key]
        && typeof target[key] === 'object'
        && !Array.isArray(target[key])
        && JSON.stringify(target[key]) === JSON.stringify(value)
      ) {
        continue
      }
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {}
      }
      applySnapshot(target[key], value)
      continue
    }

    if (target[key] !== value) {
      target[key] = value
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
