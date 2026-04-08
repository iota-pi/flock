import type { RealtimeBusEvent } from '../shared/realtime'

const REALTIME_BUS_PREFIX = 'flock-realtime-bus'

export function getRealtimeBusChannelName(account: string): string {
  return `${REALTIME_BUS_PREFIX}:${account}`
}

export function createRealtimeBusChannel(account: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined' || !account) {
    return null
  }

  return new BroadcastChannel(getRealtimeBusChannelName(account))
}

export function postRealtimeBusEvent(account: string, event: RealtimeBusEvent): void {
  const channel = createRealtimeBusChannel(account)
  if (!channel) {
    return
  }

  channel.postMessage(event)
  channel.close()
}

export function isRealtimeBusEvent(value: unknown): value is RealtimeBusEvent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as { type?: unknown; itemId?: unknown; itemIds?: unknown }

  if (candidate.type === 'LOCAL_EDIT') {
    return typeof candidate.itemId === 'string' && candidate.itemId.length > 0
  }

  if (candidate.type === 'REMOTE_UPDATED' || candidate.type === 'SYNC_PING') {
    return Array.isArray(candidate.itemIds)
      && candidate.itemIds.every(itemId => typeof itemId === 'string' && itemId.length > 0)
  }

  return false
}
