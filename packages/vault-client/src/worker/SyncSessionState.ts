/**
 * The state every component of one sync session reads: whether the device is online, and whether the
 * session is shutting down. Each session has its own, so nothing outlives it. The worker sets the
 * online state, and the context marks the session shut down before stopping its components.
 */
export class SyncSessionState {
  private online: boolean
  private shutDown = false

  constructor(options: { isOnline?: boolean } = {}) {
    this.online = options.isOnline ?? true
  }

  get isOnline(): boolean {
    return this.online
  }

  get isShutdown(): boolean {
    return this.shutDown
  }

  /** Whether this session may sync with the server: it's running and online */
  get isOperational(): boolean {
    return !this.shutDown && this.online
  }

  /** Returns whether the state changed */
  setOnline(isOnline: boolean): boolean {
    if (this.online === isOnline) return false
    this.online = isOnline
    return true
  }

  markShutdown(): void {
    this.shutDown = true
  }
}
