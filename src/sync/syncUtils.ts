import deepEqual from 'fast-deep-equal'
import { z } from 'zod'

export type StableSnapshot<T> = {
  value: T
}

export function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`).join(',')}}`
  }

  return JSON.stringify(String(value))
}

export function readStableSnapshot<T>(
  value: T,
  snapshotRef: { current: StableSnapshot<T> | null },
): T {
  if (snapshotRef.current && deepEqual(snapshotRef.current.value, value)) {
    return snapshotRef.current.value
  }

  snapshotRef.current = {
    value,
  }

  return value
}

export function normalizeItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const deduped = new Set<string>()

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue
    }

    const normalized = entry.trim()
    if (normalized.length === 0 || deduped.has(normalized)) {
      continue
    }

    deduped.add(normalized)
  }

  return Array.from(deduped)
}

export function parseWithSchema<T>(value: unknown, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type DebouncedNotifier = {
  schedule: () => void
  cancel: () => void
}

export function createDebouncedNotifier(callback: () => void, debounceMs: number): DebouncedNotifier {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (timeoutId !== null) {
      return
    }

    timeoutId = setTimeout(() => {
      timeoutId = null
      callback()
    }, debounceMs)
  }

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return {
    schedule,
    cancel,
  }
}
