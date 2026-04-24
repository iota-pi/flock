import { RealtimeWebSocketTransport } from '../api/realtime/realtimeWebSocketTransport'
import { parseRealtimePayload } from '../api/realtime/payload'
import env from '../env'
import { getApiAuthToken } from '../api/runtime'
import { EventEmitter } from 'eventemitter3'

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class NetworkTimeoutError extends Error {
  constructor(message = 'Network Timeout') {
    super(message)
    this.name = 'NetworkTimeoutError'
  }
}

export class SyncTransportService extends EventEmitter {
  private transport: RealtimeWebSocketTransport | null = null
  private account: string | null = null
  private sendQueue: Promise<void> = Promise.resolve()

  private resetSendQueue(): void {
    this.sendQueue = Promise.resolve()
  }

  public start(account: string): void {
    if (this.account === account && this.transport) {
      return
    }

    this.stop()
    this.account = account
    this.resetSendQueue()

    this.transport = new RealtimeWebSocketTransport({
      account,
      endpoint: env.VAULT_WS_ENDPOINT,
      getLastEventId: () => 0,
      getToken: () => getApiAuthToken(),
      onOpen: () => {
        this.resetSendQueue()
        this.emit('open')
      },
      onRawMessage: rawData => {
        const payload = parseRealtimePayload(rawData)
        if (payload) {
          this.emit('message', payload)
        }
      },
    })

    this.transport.start()
  }

  public stop(): void {
    this.resetSendQueue()
    this.transport?.stop()
    this.transport = null
    this.account = null
  }

  public enqueueSend(task: () => Promise<void>): void {
    if (!this.transport || !this.account) {
      return
    }

    this.sendQueue = this.sendQueue
      .then(task)
      .catch(error => {
        console.error('[SyncTransportService] Failed to push message. Reconnecting transport.', error)
        this.emit('close')
        // Automatically recover transport if it fails instead of bricking
        if (this.account) {
          this.start(this.account)
        }
      })
  }

  public sendRaw(action: string, itemId: string, encryptedMessage: unknown): void {
    if (!this.transport || !this.account) return
    this.transport.sendRaw({
      action,
      account: this.account,
      itemId,
      encryptedMessage,
    })
  }
}
