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

export class RealtimeWebSocketTransport {
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private socket: WebSocket | null = null
  private stopped = false

  constructor(private readonly options: RealtimeWebSocketTransportOptions) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearReconnectTimer()
    this.closeWebSocket()
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return
    }

    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private closeWebSocket(): void {
    if (!this.socket) {
      return
    }

    this.socket.close()
    this.socket = null
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    if (this.stopped) {
      return
    }

    this.reconnectAttempts += 1
    const backoff = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** (this.reconnectAttempts - 1)))
    const jitter = Math.random() * 0.2 * backoff
    const delay = Math.floor(backoff + jitter)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private connect(): void {
    if (this.stopped) {
      return
    }

    this.closeWebSocket()

    const token = this.options.getToken()
    if (!token || !this.options.endpoint) {
      this.scheduleReconnect()
      return
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
    const nextSocket = new WebSocket(`${wsEndpoint}?${params.toString()}`)
    this.socket = nextSocket

    nextSocket.onopen = () => {
      this.reconnectAttempts = 0
      this.options.onOpen()
    }

    nextSocket.onmessage = event => {
      this.options.onRawMessage(typeof event.data === 'string' ? event.data : null)
    }

    nextSocket.onerror = () => {
      this.closeWebSocket()
      this.scheduleReconnect()
    }

    nextSocket.onclose = () => {
      this.closeWebSocket()
      this.scheduleReconnect()
    }
  }
}