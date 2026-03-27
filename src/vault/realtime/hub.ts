import type { RealtimeEventEnvelope, RealtimeEventType } from '../../shared/realtime'

const MAX_REPLAY_EVENTS_PER_ACCOUNT = 500

const accountSubscribers = new Map<string, Set<(event: RealtimeEventEnvelope) => void>>()
const accountReplayLog = new Map<string, RealtimeEventEnvelope[]>()
const accountCounters = new Map<string, number>()

function getNextEventId(account: string): number {
  const current = accountCounters.get(account) || 0
  const next = current + 1
  accountCounters.set(account, next)
  return next
}

function appendReplayEvent(account: string, event: RealtimeEventEnvelope): void {
  const existing = accountReplayLog.get(account) || []
  existing.push(event)

  if (existing.length > MAX_REPLAY_EVENTS_PER_ACCOUNT) {
    existing.splice(0, existing.length - MAX_REPLAY_EVENTS_PER_ACCOUNT)
  }

  accountReplayLog.set(account, existing)
}

export function publishRealtimeEvent<T>(
  account: string,
  eventType: RealtimeEventType,
  data: T,
): RealtimeEventEnvelope<T> {
  const event: RealtimeEventEnvelope<T> = {
    eventId: getNextEventId(account),
    eventType,
    account,
    createdAt: Date.now(),
    data,
  }

  appendReplayEvent(account, event)

  const subscribers = accountSubscribers.get(account)
  if (subscribers) {
    for (const subscriber of subscribers.values()) {
      subscriber(event)
    }
  }

  return event
}

export function getRealtimeEventsSince(account: string, lastEventId?: number): RealtimeEventEnvelope[] {
  const replay = accountReplayLog.get(account) || []
  if (!lastEventId || lastEventId <= 0) {
    return replay
  }

  return replay.filter(event => event.eventId > lastEventId)
}

export function subscribeToRealtimeEvents(
  account: string,
  listener: (event: RealtimeEventEnvelope) => void,
): () => void {
  const existing = accountSubscribers.get(account) || new Set<(event: RealtimeEventEnvelope) => void>()
  existing.add(listener)
  accountSubscribers.set(account, existing)

  return () => {
    const subscribers = accountSubscribers.get(account)
    if (!subscribers) {
      return
    }

    subscribers.delete(listener)
    if (subscribers.size === 0) {
      accountSubscribers.delete(account)
    }
  }
}
