import { abortReason } from '../utils/abort'

/**
 * The state every component of one sync session reads: whether the device is online, whether this
 * tab is the leader, and whether the session is shutting down. Each session has its own, so nothing
 * outlives it. The worker sets the online state, the orchestrator the leadership (and emits
 * `leaderChange`), and the context marks the session shut down before stopping its components.
 */
export class SyncSessionState {
  private online: boolean
  private leader = false
  private shutDown = false
  private leaderWaiters: Array<() => void> = []

  constructor(options: { isOnline?: boolean; isLeader?: boolean } = {}) {
    this.online = options.isOnline ?? true
    this.leader = options.isLeader ?? false
  }

  get isOnline(): boolean {
    return this.online
  }

  get isLeader(): boolean {
    return this.leader
  }

  get isShutdown(): boolean {
    return this.shutDown
  }

  /** Whether this tab may sync with the server: the session is running, online and the leader */
  get isOperational(): boolean {
    return !this.shutDown && this.online && this.leader
  }

  /** Returns whether the state changed */
  setOnline(isOnline: boolean): boolean {
    if (this.online === isOnline) return false
    this.online = isOnline
    return true
  }

  /** Returns whether the state changed */
  setLeader(isLeader: boolean): boolean {
    if (this.leader === isLeader) return false
    this.leader = isLeader
    if (isLeader) {
      for (const resolve of this.leaderWaiters) resolve()
      this.leaderWaiters = []
    }
    return true
  }

  /** Resolves once this tab is the leader, or rejects with the signal's reason if it aborts first */
  whenLeader(signal?: AbortSignal): Promise<void> {
    if (this.leader) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    return new Promise((resolve, reject) => {
      const waiter = () => {
        resolve()
      }
      // A waiter left behind would hold the caller until this tab next leads
      signal?.addEventListener('abort', () => {
        this.leaderWaiters = this.leaderWaiters.filter(other => other !== waiter)
        reject(abortReason(signal))
      }, { once: true })
      this.leaderWaiters.push(waiter)
    })
  }

  markShutdown(): void {
    this.shutDown = true
  }
}
