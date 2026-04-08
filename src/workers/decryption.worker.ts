/// <reference lib="webworker" />
import * as Automerge from '@automerge/automerge'
import { expose } from 'comlink'

type MergeObjectsWorkerInput = {
  left: Record<string, unknown>
  right: Record<string, unknown>
}

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

function mergePlainObjectsWithAutomerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const leftDoc = Automerge.from(stripUndefinedDeep(left) as Record<string, unknown>)
  const rightDoc = Automerge.from(stripUndefinedDeep(right) as Record<string, unknown>)
  const merged = Automerge.merge(leftDoc, rightDoc)
  return Automerge.toJS(merged) as Record<string, unknown>
}

const workerApi = {
  async mergeObjects(input: MergeObjectsWorkerInput): Promise<Record<string, unknown>> {
    return mergePlainObjectsWithAutomerge(input.left, input.right)
  },
}

expose(workerApi)
