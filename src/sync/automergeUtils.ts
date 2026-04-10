import type { WorkerDocumentPatch } from '../workers/automergeDocWorkerManager'

export function normalizeJsonValue<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T
}

export function normalizeForAutomerge(input: Record<string, unknown>): Record<string, unknown> {
  return normalizeJsonValue(input)
}

function isPatchPathSegment(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}

export function normalizePatchValue(value: unknown): unknown {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return normalizeJsonValue(value)
  }

  return value
}

export function normalizeWorkerDocumentPatches(patches: WorkerDocumentPatch[]): WorkerDocumentPatch[] {
  const normalizedPatches: WorkerDocumentPatch[] = []

  for (const patch of patches) {
    const path = patch && Array.isArray(patch.path) ? patch.path : []
    if (path.length === 0 || path.some(segment => !isPatchPathSegment(segment))) {
      continue
    }

    if (patch.op === 'remove') {
      normalizedPatches.push({
        op: 'remove',
        path,
      })
      continue
    }

    if (patch.op !== 'add' && patch.op !== 'replace') {
      continue
    }

    if (patch.value === undefined) {
      normalizedPatches.push({
        op: 'remove',
        path,
      })
      continue
    }

    normalizedPatches.push({
      op: patch.op,
      path,
      value: normalizePatchValue(patch.value),
    })
  }

  return normalizedPatches
}
