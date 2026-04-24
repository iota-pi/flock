import type {
  RealtimeEventEnvelope,
  RealtimeSyncPing,
  RealtimeDirectSyncPush,
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

export function parseRealtimePayload(rawData: string | null | undefined): RealtimeEventEnvelope | RealtimeSyncPing | RealtimeDirectSyncPush | null {
  if (!rawData) {
    return null
  }

  try {
    const payload = JSON.parse(rawData) as RealtimeEventEnvelope | RealtimeSyncPing | RealtimeDirectSyncPush

    if ('action' in payload && payload.action === 'sync_ping') {
      return {
        ...payload,
        itemIds: normalizeRealtimeItemIds(payload.itemIds),
      }
    }

    if ('action' in payload && payload.action === 'direct_sync_push') {
      return payload
    }

    if ('eventType' in payload && 'account' in payload) {
      return payload
    }

    return null
  } catch {
    return null
  }
}