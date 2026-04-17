export type DocumentPatch = {
  op: 'add' | 'replace' | 'remove'
  path: Array<string | number>
  value?: unknown
}

type PatchParent = Record<string | number, unknown>

type PatchTarget = {
  key: string | number
  parent: PatchParent
}

function isObjectLike(value: unknown): value is Record<string | number, unknown> {
  return value !== null && typeof value === 'object'
}

function clonePatchValue(value: unknown): unknown {
  if (!isObjectLike(value) && !Array.isArray(value)) {
    return value
  }

  return structuredClone(value)
}

function getPatchTarget(root: Record<string, unknown>, path: Array<string | number>): PatchTarget | null {
  if (path.length === 0) {
    return null
  }

  let current: PatchParent = root

  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    const nextKey = path[index + 1]
    const existing = current[key]

    if (isObjectLike(existing) || Array.isArray(existing)) {
      current = existing as PatchParent
      continue
    }

    const replacement = typeof nextKey === 'number' ? [] : {}
    current[key] = replacement
    current = replacement as PatchParent
  }

  return {
    key: path[path.length - 1],
    parent: current,
  }
}

export function applyDocumentPatch(document: Record<string, unknown>, patch: DocumentPatch): void {
  const target = getPatchTarget(document, patch.path)
  if (!target) {
    return
  }

  const { key, parent } = target

  if (patch.op === 'remove') {
    if (Array.isArray(parent) && typeof key === 'number') {
      delete parent[key]
      return
    }

    delete parent[key]
    return
  }

  parent[key] = clonePatchValue(patch.value)
}
