export interface LeaderElectionCallbacks {
  onLeaderGranted: () => void
  onLeaderRevoked: () => void
  onMultipleLeadersDetected?: () => void
  onSoleLeaderRestored?: () => void
}

export interface LeaderElectionOptions {
  maxLockRetries?: number
  retryDelayMs?: number
  presenceHeartbeatIntervalMs?: number
  presenceTimeoutMs?: number
}

interface PresenceMessage {
  type: 'heartbeat' | 'release'
  leaderId: string
  isFallback?: boolean
}

export class LeaderElection {
  private releaseLeadershipLock: (() => void) | null = null
  private abortController: AbortController | null = null
  private retryTimeout: ReturnType<typeof setTimeout> | null = null
  private isLeader = false
  private isFallback = false
  private isReleased = false
  private consecutiveFailures = 0

  private readonly maxLockRetries: number
  private readonly retryDelayMs: number
  private readonly presenceHeartbeatIntervalMs: number
  private readonly presenceTimeoutMs: number

  // Presence channel tracking
  private leaderId: string | null = null
  private presenceChannel: BroadcastChannel | null = null
  private presenceTimer: ReturnType<typeof setInterval> | null = null
  private otherLeaders = new Map<string, number>()
  private multipleLeadersDetected = false

  constructor(
    private accountId: string,
    private callbacks: LeaderElectionCallbacks,
    options?: LeaderElectionOptions
  ) {
    this.maxLockRetries = options?.maxLockRetries ?? 3
    this.retryDelayMs = options?.retryDelayMs ?? 1000
    this.presenceHeartbeatIntervalMs = options?.presenceHeartbeatIntervalMs ?? 2000
    this.presenceTimeoutMs = options?.presenceTimeoutMs ?? 5000
  }

  get leader(): boolean {
    return this.isLeader
  }

  get fallback(): boolean {
    return this.isFallback
  }

  get activeOtherLeaderCount(): number {
    return this.otherLeaders.size
  }

  private grantLeadership(isFallback = false): void {
    if (!this.isLeader) {
      this.isLeader = true
      this.isFallback = isFallback
      this.setupPresence()
      this.callbacks.onLeaderGranted()
    }
  }

  private revokeLeadership(): void {
    if (this.isLeader) {
      this.isLeader = false
      this.isFallback = false
      this.teardownPresence()
      this.callbacks.onLeaderRevoked()
    }
  }

  private setupPresence(): void {
    if (typeof BroadcastChannel === 'undefined') {
      return
    }

    try {
      this.leaderId = `leader-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
      this.presenceChannel = new BroadcastChannel(`flock-leader-presence-${this.accountId}`)

      this.presenceChannel.onmessage = (event: MessageEvent<PresenceMessage>) => {
        this.handlePresenceMessage(event.data)
      }

      this.sendHeartbeat()

      this.presenceTimer = setInterval(() => {
        this.sendHeartbeat()
        this.pruneStaleLeaders()
      }, this.presenceHeartbeatIntervalMs)
    } catch (err) {
      console.warn('[LeaderElection] Failed to initialize leader presence BroadcastChannel:', err)
      this.presenceChannel = null
    }
  }

  private sendHeartbeat(): void {
    if (!this.presenceChannel || !this.leaderId || !this.isLeader) return
    try {
      const msg: PresenceMessage = {
        type: 'heartbeat',
        leaderId: this.leaderId,
        isFallback: this.isFallback,
      }
      this.presenceChannel.postMessage(msg)
    } catch (_) {}
  }

  private handlePresenceMessage(data: PresenceMessage): void {
    if (!data || !data.leaderId || data.leaderId === this.leaderId || !this.isLeader) {
      return
    }

    if (data.type === 'heartbeat') {
      this.otherLeaders.set(data.leaderId, Date.now())
      if (!this.multipleLeadersDetected) {
        this.multipleLeadersDetected = true
        this.callbacks.onMultipleLeadersDetected?.()
      }
    } else if (data.type === 'release') {
      this.otherLeaders.delete(data.leaderId)
      if (this.otherLeaders.size === 0 && this.multipleLeadersDetected) {
        this.multipleLeadersDetected = false
        this.callbacks.onSoleLeaderRestored?.()
      }
    }
  }

  private pruneStaleLeaders(): void {
    if (!this.isLeader) return
    const now = Date.now()
    let removed = false

    for (const [leaderId, lastSeen] of Array.from(this.otherLeaders.entries())) {
      if (now - lastSeen > this.presenceTimeoutMs) {
        this.otherLeaders.delete(leaderId)
        removed = true
      }
    }

    if (removed && this.otherLeaders.size === 0 && this.multipleLeadersDetected) {
      this.multipleLeadersDetected = false
      this.callbacks.onSoleLeaderRestored?.()
    }
  }

  private teardownPresence(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer)
      this.presenceTimer = null
    }

    if (this.presenceChannel) {
      if (this.leaderId) {
        try {
          const msg: PresenceMessage = {
            type: 'release',
            leaderId: this.leaderId,
          }
          this.presenceChannel.postMessage(msg)
        } catch (_) {}
      }
      try {
        this.presenceChannel.close()
      } catch (_) {}
      this.presenceChannel = null
    }

    this.leaderId = null
    this.otherLeaders.clear()
    this.multipleLeadersDetected = false
  }

  async acquire(): Promise<void> {
    this.release()
    this.isReleased = false
    this.consecutiveFailures = 0

    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.grantLeadership(true)
      return
    }

    this.acquireLock()
  }

  private acquireLock(): void {
    if (this.isReleased) {
      return
    }

    const lockName = `flock-sync-leader-${this.accountId}`
    const abortController = new AbortController()
    this.abortController = abortController

    try {
      void navigator.locks
        .request(lockName, { signal: abortController.signal }, async () => {
          this.consecutiveFailures = 0
          this.grantLeadership(false)

          return new Promise<void>(resolve => {
            this.releaseLeadershipLock = () => {
              this.revokeLeadership()
              resolve()
            }
          })
        })
        .catch((err: unknown) => {
          this.handleLockError(err, abortController)
        })
    } catch (err: unknown) {
      this.handleLockError(err, abortController)
    }
  }

  private handleLockError(err: unknown, abortController: AbortController): void {
    if (
      this.isReleased ||
      abortController.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError') ||
      (err as { name?: string })?.name === 'AbortError'
    ) {
      return
    }

    this.revokeLeadership()
    this.consecutiveFailures++

    if (this.consecutiveFailures < this.maxLockRetries) {
      console.error(
        `[LeaderElection] Failed to acquire lock (attempt ${this.consecutiveFailures}/${this.maxLockRetries})`,
        err
      )
      const delay = this.retryDelayMs * Math.pow(2, this.consecutiveFailures - 1)
      this.retryTimeout = setTimeout(() => {
        this.retryTimeout = null
        if (!this.isReleased) {
          this.acquireLock()
        }
      }, delay)
    } else {
      console.warn(
        `[LeaderElection] Web Locks permanently failed after ${this.consecutiveFailures} attempts. Falling back to leader mode so syncing is not blocked.`,
        err
      )
      this.grantLeadership(true)
    }
  }

  release(): void {
    this.isReleased = true

    if (this.retryTimeout !== null) {
      clearTimeout(this.retryTimeout)
      this.retryTimeout = null
    }

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    if (this.releaseLeadershipLock) {
      this.releaseLeadershipLock()
      this.releaseLeadershipLock = null
    } else {
      this.revokeLeadership()
    }

    this.teardownPresence()
  }
}
