import { WebSocket as PartyWebSocket } from 'partysocket'

type RealtimeWebSocketTransportOptions = {
  account: string
  endpoint?: string
  getLastEventId: () => number
  getToken: () => string | null
  onOpen: () => void
  onRawMessage: (rawData: string | null | undefined) => void
}

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const RECONNECT_GROWTH_FACTOR = 2
const HEARTBEAT_INTERVAL_MS = 60_000

export class RealtimeWebSocketTransport {
  private socket: PartyWebSocket | null = null
  private stopped = false
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: RealtimeWebSocketTransportOptions) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.closeWebSocket()
  }

  sendRaw(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) {
      return
    }

    const body = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload)

    this.socket.send(body)
  }

  private closeWebSocket(): void {
    this.stopHeartbeat()

    if (!this.socket) {
      return
    }

    this.socket.close(1000, 'Realtime transport stopped')
    this.socket = null
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.sendRaw({ action: 'ping' })

    this.heartbeatIntervalId = setInterval(() => {
      if (this.stopped) {
        return
      }

      this.sendRaw({ action: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatIntervalId === null) {
      return
    }

    clearInterval(this.heartbeatIntervalId)
    this.heartbeatIntervalId = null
  }

  private buildWebSocketUrl(): string {
    const token = this.options.getToken()
    if (!token || !this.options.endpoint) {
      throw new Error('Missing realtime websocket token or endpoint')
    }

    const params = new URLSearchParams({
      account: this.options.account,
      token,
    })

    const lastEventId = this.options.getLastEventId()
    if (lastEventId > 0) {
      params.set('lastEventId', String(lastEventId))
    }

    const wsEndpoint = this.options.endpoint.replace(/^http/i, 'ws')
    return `${wsEndpoint}?${params.toString()}`
  }

  private connect(): void {
    if (this.stopped) {
      return
    }

    this.closeWebSocket()

    const nextSocket = new PartyWebSocket(
      () => this.buildWebSocketUrl(),
      [],
      {
        minReconnectionDelay: RECONNECT_BASE_DELAY_MS,
        maxReconnectionDelay: RECONNECT_MAX_DELAY_MS,
        reconnectionDelayGrowFactor: RECONNECT_GROWTH_FACTOR,
        maxRetries: Infinity,
      },
    )

    this.socket = nextSocket

    nextSocket.onopen = () => {
      if (this.stopped) {
        return
      }

      this.startHeartbeat()
      this.options.onOpen()
    }

    nextSocket.onmessage = event => {
      if (this.stopped) {
        return
      }

      this.options.onRawMessage(typeof event.data === 'string' ? event.data : null)
    }

    nextSocket.onclose = () => {
      if (this.socket === nextSocket) {
        this.stopHeartbeat()
      }

      if (this.stopped && this.socket === nextSocket) {
        this.socket = null
      }
    }
  }
}