export type RealtimeEventType =
  | 'items.updated'
  | 'items.deleted'
  | 'metadata.updated'
  | 'system.heartbeat'

export interface RealtimeEventEnvelope<T = unknown> {
  eventId: number
  eventType: RealtimeEventType
  account: string
  createdAt: number
  data: T
}

export type RealtimeSyncPing = {
  action: 'sync_ping'
  itemIds: string[]
}
