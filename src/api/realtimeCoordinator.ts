import env from '../env'
import type {
  RealtimeChannelMessage,
  RealtimeEventEnvelope,
} from '../shared/realtime'
import { getApiAuthToken } from './runtime'

type RealtimeCoordinatorOptions = {
  account: string
  onServerEvent: (event: RealtimeEventEnvelope) => void
}

type RealtimeCoordinatorHandle = {
  stop: () => void
}

const LEADER_HEARTBEAT_INTERVAL_MS = 2000
const LEADER_STALE_MS = 7000
const ELECTION_DELAY_MS = 600
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000

let activeHandle: RealtimeCoordinatorHandle | null = null
let activeKey = ''

function getLastEventIdStorageKey(account: string): string {
  return `realtime:lastEventId:${account}`
}

function readLastEventId(account: string): number {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 0
  }

  const rawValue = window.localStorage.getItem(getLastEventIdStorageKey(account))
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }

  return parsed
}

function writeLastEventId(account: string, eventId: number): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  window.localStorage.setItem(getLastEventIdStorageKey(account), String(eventId))
}

function createTabId(): string {
  const randomPart = Math.random().toString(36).slice(2)
  return `tab_${Date.now()}_${randomPart}`
}

export function startRealtimeCoordinator(options: RealtimeCoordinatorOptions): void {
  const key = `${options.account}:${getApiAuthToken()}`
  if (activeHandle && activeKey === key) {
    return
  }

  stopRealtimeCoordinator()

  if (typeof window === 'undefined') {
    return
  }

  activeKey = key
  activeHandle = createCoordinator(options)
}

export function stopRealtimeCoordinator(): void {
  if (!activeHandle) {
    return
  }

  activeHandle.stop()
  activeHandle = null
  activeKey = ''
}

function createCoordinator({ account, onServerEvent }: RealtimeCoordinatorOptions): RealtimeCoordinatorHandle {
  const tabId = createTabId()
  const supportsBroadcastChannel = typeof BroadcastChannel !== 'undefined'
  const channelName = `flock:realtime:${account}`
  const channel = supportsBroadcastChannel ? new BroadcastChannel(channelName) : null

  let stopped = false
  let isLeader = false
  let leaderTabId: string | null = null
  let leaderLastSeenAt = 0
  let reconnectAttempts = 0

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let staleLeaderTimer: ReturnType<typeof setInterval> | null = null
  let electionTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let socket: WebSocket | null = null

  const emit = (message: RealtimeChannelMessage) => {
    if (!channel) {
      return
    }
    channel.postMessage(message)
  }

  const handleServerEvent = (event: RealtimeEventEnvelope) => {
    if (event.account !== account) {
      return
    }

    if (typeof event.eventId === 'number' && event.eventId > 0) {
      writeLastEventId(account, event.eventId)
    }

    onServerEvent(event)
  }

  const parseAndHandleEvent = (rawData: string | null | undefined) => {
    if (!rawData) {
      return
    }

    try {
      const payload = JSON.parse(rawData) as RealtimeEventEnvelope
      handleServerEvent(payload)
      emit({ type: 'server-event', tabId, event: payload })
    } catch {
      // Ignore malformed events to keep the connection alive.
    }
  }

  const closeWebSocket = () => {
    if (!socket) {
      return
    }
    socket.close()
    socket = null
  }

  const clearReconnectTimer = () => {
    if (!reconnectTimer) {
      return
    }
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function connectWebSocket() {
    if (stopped || !isLeader) {
      return
    }

    closeWebSocket()

    const token = getApiAuthToken()
    if (!token || !env.VAULT_WS_ENDPOINT) {
      scheduleReconnect()
      return
    }

    const params = new URLSearchParams({ account, token })

    const lastEventId = readLastEventId(account)
    if (lastEventId > 0) {
      params.set('lastEventId', String(lastEventId))
    }

    const wsEndpoint = env.VAULT_WS_ENDPOINT.replace(/^http/i, 'ws')
    const ws = new WebSocket(`${wsEndpoint}?${params.toString()}`)
    socket = ws

    ws.onopen = () => {
      reconnectAttempts = 0
      emit({ type: 'reconnecting', tabId, reconnecting: false })
    }

    ws.onmessage = event => {
      parseAndHandleEvent(typeof event.data === 'string' ? event.data : null)
    }

    ws.onerror = () => {
      closeWebSocket()
      scheduleReconnect()
    }

    ws.onclose = () => {
      closeWebSocket()
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer()
    if (stopped || !isLeader) {
      return
    }

    reconnectAttempts += 1
    const backoff = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** (reconnectAttempts - 1)))
    const jitter = Math.random() * 0.2 * backoff
    const delay = Math.floor(backoff + jitter)
    emit({ type: 'reconnecting', tabId, reconnecting: true })

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped || !isLeader) {
        return
      }
      connectWebSocket()
    }, delay)
  }

  const becomeLeader = () => {
    if (stopped || isLeader) {
      return
    }

    isLeader = true
    leaderTabId = tabId
    leaderLastSeenAt = Date.now()

    emit({ type: 'im-leader', tabId })

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        emit({ type: 'leader-alive', tabId, timestamp: Date.now() })
      }, LEADER_HEARTBEAT_INTERVAL_MS)
    }

    connectWebSocket()
  }

  const stepDownAsLeader = () => {
    if (!isLeader) {
      return
    }

    isLeader = false
    leaderTabId = null

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    closeWebSocket()
    clearReconnectTimer()
  }

  function relinquishLeadership() {
    if (!isLeader) {
      return
    }

    emit({ type: 'leader-dying', tabId })
    stepDownAsLeader()
  }

  const requestLeader = () => {
    emit({ type: 'request-leader', tabId })

    if (electionTimer) {
      clearTimeout(electionTimer)
    }

    electionTimer = setTimeout(() => {
      electionTimer = null
      if (stopped || isLeader) {
        return
      }

      const leaderIsFresh = leaderLastSeenAt > 0 && (Date.now() - leaderLastSeenAt) < LEADER_STALE_MS
      if (!leaderIsFresh) {
        becomeLeader()
      }
    }, ELECTION_DELAY_MS)
  }

  const handleChannelMessage = (message: RealtimeChannelMessage) => {
    if (message.tabId === tabId) {
      return
    }

    if (message.type === 'request-leader') {
      if (isLeader) {
        emit({ type: 'im-leader', tabId })
      }
      return
    }

    if (message.type === 'im-leader') {
      leaderTabId = message.tabId
      leaderLastSeenAt = Date.now()
      if (isLeader && message.tabId !== tabId) {
        stepDownAsLeader()
      }
      return
    }

    if (message.type === 'leader-alive') {
      leaderTabId = message.tabId
      leaderLastSeenAt = message.timestamp
      if (isLeader && message.tabId !== tabId) {
        stepDownAsLeader()
      }
      return
    }

    if (message.type === 'leader-dying') {
      if (leaderTabId === message.tabId) {
        leaderTabId = null
        leaderLastSeenAt = 0
        requestLeader()
      }
      return
    }

    if (message.type === 'server-event') {
      handleServerEvent(message.event)
    }
  }

  if (channel) {
    channel.onmessage = event => {
      handleChannelMessage(event.data as RealtimeChannelMessage)
    }
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      relinquishLeadership()
      return
    }

    if (!isLeader) {
      requestLeader()
    }
  }

  const handlePageHide = () => {
    relinquishLeadership()
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('beforeunload', handlePageHide)

  if (!supportsBroadcastChannel) {
    becomeLeader()
  } else {
    requestLeader()

    staleLeaderTimer = setInterval(() => {
      if (stopped || isLeader) {
        return
      }

      const leaderIsFresh = leaderLastSeenAt > 0 && (Date.now() - leaderLastSeenAt) < LEADER_STALE_MS
      if (!leaderIsFresh) {
        requestLeader()
      }
    }, LEADER_HEARTBEAT_INTERVAL_MS)
  }

  return {
    stop: () => {
      if (stopped) {
        return
      }
      stopped = true

      if (isLeader) {
        emit({ type: 'leader-dying', tabId })
      }

      stepDownAsLeader()

      if (staleLeaderTimer) {
        clearInterval(staleLeaderTimer)
        staleLeaderTimer = null
      }

      if (electionTimer) {
        clearTimeout(electionTimer)
        electionTimer = null
      }

      clearReconnectTimer()

      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('beforeunload', handlePageHide)

      if (channel) {
        channel.close()
      }
    },
  }
}
