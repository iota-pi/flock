import { z } from 'zod'

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
