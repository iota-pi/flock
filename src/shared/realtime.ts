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

export type RealtimeChannelMessage =
  | { type: 'request-leader'; tabId: string }
  | { type: 'im-leader'; tabId: string }
  | { type: 'leader-alive'; tabId: string; timestamp: number }
  | { type: 'leader-dying'; tabId: string }
  | { type: 'reconnecting'; tabId: string; reconnecting: boolean }
  | { type: 'server-event'; tabId: string; event: RealtimeEventEnvelope }
  | { type: 'sync-ping'; tabId: string; itemIds: string[] }
