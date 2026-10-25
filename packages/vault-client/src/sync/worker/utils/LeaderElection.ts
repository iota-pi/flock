import { isAbortError } from '../../utils/abort'
import { fireAndForget } from '../../utils/fireAndForget'
import { RetryStrategy } from '../../utils/RetryStrategy'
import { getVaultStorageNames } from '../../shared/storageNames'
import { createLogger } from '../../utils/logger'

const log = createLogger('LeaderElection')

export interface LeaderElectionCallbacks {
  onLeaderGranted: () => void
  onLeaderRevoked: () => void
  onMultipleLeadersDetected?: () => void
  onSoleLeaderRestored?: () => void
  onLeaderConflict?: (isConflict: boolean) => void
}

export interface LeaderElectionOptions {
  maxLockRetries?: number
  retryDelayMs?: number
  presenceHeartbeatIntervalMs?: number
  presenceTimeoutMs?: number
}

interface PresenceMessage {
  type: 'heartbeat' | 'release' | 'claim'
  leaderId: string
  createdAt?: number
  isFallback?: boolean
  isReply?: boolean
}

export class LeaderElection {
  private releaseLeadershipLock: (() => void) | null = null
  private abortController: AbortController | null = null
  private retryTimeout: ReturnType<typeof setTimeout> | null = null
  private isLeader = false
  private isFallback = false
  private isReleased = false
  private isYielded = false
  private createdAt: number = Date.now()
  private readonly lockRetry: RetryStrategy

  private readonly maxLockRetries: number
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
    const retryDelayMs = options?.retryDelayMs ?? 1000
    // The last failure falls back to leader mode instead of retrying
    const retries = Math.max(0, this.maxLockRetries - 1)
    this.lockRetry = new RetryStrategy({
      delays: Array.from({ length: retries }, (_, i) => retryDelayMs * 2 ** i),
      maxAttempts: retries,
    })
    this.presenceHeartbeatIntervalMs = options?.presenceHeartbeatIntervalMs ?? 2000
    this.presenceTimeoutMs = options?.presenceTimeoutMs ?? 5000
  }

  get leader(): boolean {
    return this.isLeader
  }

  get fallback(): boolean {
    return this.isFallback
  }

  get yielded(): boolean {
    return this.isYielded
  }

  get activeOtherLeaderCount(): number {
    return this.otherLeaders.size
  }

  private grantLeadership(isFallback = false): void {
    if (!this.isLeader) {
      this.isLeader = true
      this.isFallback = isFallback
      this.isYielded = false
      this.setupPresence()
      this.callbacks.onLeaderGranted()
      this.callbacks.onLeaderConflict?.(false)
    }
  }

  private revokeLeadership(teardown = true): void {
    if (this.isLeader) {
      this.isLeader = false
      this.isFallback = false
      if (teardown) {
        this.teardownPresence()
      }
      this.callbacks.onLeaderRevoked()
    }
  }

  private yieldLeadership(): void {
    if (!this.isYielded) {
      this.isYielded = true
      this.revokeLeadership(false)
      this.callbacks.onLeaderConflict?.(true)
    }
  }

  claimLeadership(): void {
    if (this.isReleased) return

    this.isYielded = false
    this.createdAt = Date.now()

    if (!this.presenceChannel) {
      this.setupPresence()
    }

    if (this.presenceChannel && this.leaderId) {
      try {
        const msg: PresenceMessage = {
          type: 'claim',
          leaderId: this.leaderId,
          createdAt: this.createdAt,
          isFallback: true,
        }
        this.presenceChannel.postMessage(msg)
      } catch (_) {
        // BroadcastChannel might be closed; ignore error
      }
    }

    this.grantLeadership(true)
  }

  private setupPresence(): void {
    if (typeof BroadcastChannel === 'undefined') {
      return
    }

    try {
      if (!this.leaderId) {
        this.leaderId = `leader-${Math.random().toString(36).slice(2, 10)}-${this.createdAt}`
      }
      if (!this.presenceChannel) {
        this.presenceChannel = new BroadcastChannel(`${getVaultStorageNames().accountPrefixes.leaderPresenceChannel}${this.accountId}`)

        this.presenceChannel.onmessage = (event: MessageEvent<PresenceMessage>) => {
          this.handlePresenceMessage(event.data)
        }
      }

      this.sendHeartbeat()

      if (!this.presenceTimer) {
        this.presenceTimer = setInterval(() => {
          this.sendHeartbeat()
          this.pruneStaleLeaders()
        }, this.presenceHeartbeatIntervalMs)
      }
    } catch (err) {
      log.warn('Failed to initialize leader presence BroadcastChannel:', err)
      this.presenceChannel = null
    }
  }

  private sendHeartbeat(isReply = false): void {
    if (!this.presenceChannel || !this.leaderId || !this.isLeader) return
    try {
      const msg: PresenceMessage = {
        type: 'heartbeat',
        leaderId: this.leaderId,
        createdAt: this.createdAt,
        isFallback: this.isFallback,
        isReply,
      }
      this.presenceChannel.postMessage(msg)
    } catch (_) {
      // BroadcastChannel might be closed; ignore error
    }
  }

  private handlePresenceMessage(data: PresenceMessage): void {
    if (!data || !data.leaderId || data.leaderId === this.leaderId) {
      return
    }

    if (data.type === 'claim') {
      this.otherLeaders.set(data.leaderId, Date.now())
      if (this.isLeader) {
        this.yieldLeadership()
      }
      return
    }

    if (data.type === 'heartbeat') {
      this.otherLeaders.set(data.leaderId, Date.now())

      if (!data.isReply && this.isLeader) {
        this.sendHeartbeat(true)
      }

      const totalLeaders = (this.isLeader ? 1 : 0) + this.otherLeaders.size
      if (totalLeaders > 1 && !this.multipleLeadersDetected) {
        this.multipleLeadersDetected = true
        this.callbacks.onMultipleLeadersDetected?.()
      }

      if (this.isLeader && this.isFallback) {
        if (!data.isFallback) {
          this.yieldLeadership()
          return
        }

        const otherCreatedAt = data.createdAt ?? 0
        const isSelfOlder =
          this.createdAt < otherCreatedAt ||
          (this.createdAt === otherCreatedAt && (this.leaderId ?? '') < data.leaderId)

        if (!isSelfOlder) {
          this.yieldLeadership()
          return
        }
      }
    } else if (data.type === 'release') {
      this.otherLeaders.delete(data.leaderId)
      if (this.otherLeaders.size === 0) {
        if (this.multipleLeadersDetected) {
          this.multipleLeadersDetected = false
          this.callbacks.onSoleLeaderRestored?.()
        }
        if (this.isYielded && !this.isReleased) {
          this.isYielded = false
          this.grantLeadership(this.releaseLeadershipLock === null)
        }
      }
    }
  }

  private pruneStaleLeaders(): void {
    if (this.isReleased) return
    const now = Date.now()
    let removed = false

    for (const [leaderId, lastSeen] of Array.from(this.otherLeaders.entries())) {
      if (now - lastSeen > this.presenceTimeoutMs) {
        this.otherLeaders.delete(leaderId)
        removed = true
      }
    }

    if (removed && this.otherLeaders.size === 0) {
      if (this.multipleLeadersDetected) {
        this.multipleLeadersDetected = false
        this.callbacks.onSoleLeaderRestored?.()
      }
      if (this.isYielded && !this.isReleased) {
        this.isYielded = false
        this.grantLeadership(this.releaseLeadershipLock === null)
      }
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
        } catch (_) {
          // Ignore errors sending release message
        }
      }
      try {
        this.presenceChannel.close()
      } catch (_) {
        // Ignore errors closing channel
      }
      this.presenceChannel = null
    }

    this.leaderId = null
    this.otherLeaders.clear()
    this.multipleLeadersDetected = false
    this.isYielded = false
  }

  async acquire(): Promise<void> {
    this.release()
    this.isReleased = false
    this.lockRetry.reset()
    this.createdAt = Date.now()

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

    const lockName = `${getVaultStorageNames().accountPrefixes.leaderLock}${this.accountId}`
    const abortController = new AbortController()
    this.abortController = abortController

    try {
      fireAndForget(
        navigator.locks
          .request(lockName, { signal: abortController.signal }, async () => {
            this.lockRetry.reset()
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
          }),
        'LeaderElection:acquireLock',
      )
    } catch (err: unknown) {
      this.handleLockError(err, abortController)
    }
  }

  private handleLockError(err: unknown, abortController: AbortController): void {
    if (this.isReleased || abortController.signal.aborted || isAbortError(err)) {
      return
    }

    this.revokeLeadership()

    if (this.lockRetry.canRetry) {
      const delay = this.lockRetry.nextDelay()
      log.error(
        `Failed to acquire lock (attempt ${this.lockRetry.attempt}/${this.maxLockRetries})`,
        err
      )
      this.retryTimeout = setTimeout(() => {
        this.retryTimeout = null
        if (!this.isReleased) {
          this.acquireLock()
        }
      }, delay)
    } else {
      log.warn(
        `Web Locks permanently failed after ${this.lockRetry.attempt + 1} attempts. Falling back to leader mode so syncing is not blocked.`,
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
