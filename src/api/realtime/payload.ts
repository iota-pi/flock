import type {
  RealtimeEventEnvelope,
  RealtimeSyncPing,
} from '../../shared/realtime'

function normalizeRealtimeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      continue
    }

    normalized.add(candidate)
  }

  return Array.from(normalized)
}

export function parseRealtimePayload(rawData: string | null | undefined): RealtimeEventEnvelope | RealtimeSyncPing | null {
  if (!rawData) {
    return null
  }

  try {
    const payload = JSON.parse(rawData) as RealtimeEventEnvelope | RealtimeSyncPing

    if ('action' in payload && payload.action === 'sync_ping') {
      return {
        ...payload,
        itemIds: normalizeRealtimeItemIds(payload.itemIds),
      }
    }

    if ('eventType' in payload && 'account' in payload) {
      return payload
    }

    return null
  } catch {
    return null
  }
}