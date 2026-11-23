import { isAbortError } from '../../utils/abort'
import { fireAndForget } from '../../utils/fireAndForget'
import { RetryStrategy } from '../../utils/RetryStrategy'
import { RetryTimer } from '../../utils/RetryTimer'
import { getVaultStorageNames } from '../../shared/storageNames'
import { createLogger } from '../../utils/logger'

const log = createLogger('LeaderElection')

export interface LeaderElectionCallbacks {
  onLeaderGranted: () => void
  onLeaderRevoked: () => void
}

export interface LeaderElectionOptions {
  maxLockRetries?: number
  retryDelayMs?: number
  /** How often a leader tells tabs of the previous release that it leads (see `LegacyLeaderClaims`) */
  legacyClaimIntervalMs?: number
}

/** One request this tab has made for the leader lock, queued or held */
class LockRequest {
  readonly abortController = new AbortController()
  granted = false
  /** Ends the hold, which releases the lock. Set once the lock is granted. */
  end: (() => void) | null = null
}

function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks
}

/**
 * Tabs of the previous release yield to a `claim` on the presence channel, and ignore a stolen lock,
 * so while one may still be open (a service worker update leaves old tabs running) the leader keeps
 * claiming. An old tab forgets a claimer it hasn't heard from in 5s, and takes over again at once
 * when it hears `release`. Delete this, and the `leaderPresenceChannel` storage name with it, once no
 * tab of a release before lock stealing can be open.
 */
class LegacyLeaderClaims {
  private readonly leaderId = `leader-${crypto.randomUUID()}`
  private channel: BroadcastChannel | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly accountId: string,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer || typeof BroadcastChannel === 'undefined') return
    try {
      this.channel = new BroadcastChannel(`${getVaultStorageNames().accountPrefixes.leaderPresenceChannel}${this.accountId}`)
    } catch (error) {
      log.warn('Could not open the leader presence channel', error)
      return
    }
    this.post({ type: 'claim', leaderId: this.leaderId, createdAt: Date.now(), isFallback: false })
    this.timer = setInterval(
      () => this.post({ type: 'claim', leaderId: this.leaderId, createdAt: Date.now(), isFallback: false }),
      this.intervalMs,
    )
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.channel) return
    this.post({ type: 'release', leaderId: this.leaderId })
    try {
      this.channel.close()
    } catch {
      // Already closed
    }
    this.channel = null
  }

  private post(message: object): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // The channel may be closed
    }
  }
}

/**
 * The leader is the tab that holds the account's leader lock (`navigator.locks`). Every other tab
 * queues for it. A tab that has to lead now (a user action that needs the server, or the user coming
 * back to it while the leader's tab is hidden) steals the lock: the browser grants it at once and
 * rejects the holder's request with an `AbortError`, so the holder stops leading and queues again.
 */
export class LeaderElection {
  /** The request this tab has made for the lock, queued or held */
  private request: LockRequest | null = null
  /** The steal in progress, which concurrent claims share */
  private claim: Promise<boolean> | null = null
  private readonly lockRetryTimer = new RetryTimer()
  private readonly lockRetry: RetryStrategy
  private readonly maxLockRetries: number
  private readonly legacyClaims: LegacyLeaderClaims
  private isLeader = false
  private isReleased = true

  constructor(
    private readonly accountId: string,
    private readonly callbacks: LeaderElectionCallbacks,
    options?: LeaderElectionOptions
  ) {
    this.maxLockRetries = options?.maxLockRetries ?? 3
    const retryDelayMs = options?.retryDelayMs ?? 1000
    // The last failure falls back to leading without the lock instead of retrying
    const retries = Math.max(0, this.maxLockRetries - 1)
    this.lockRetry = new RetryStrategy({
      delays: Array.from({ length: retries }, (_, i) => retryDelayMs * 2 ** i),
      maxAttempts: retries,
    })
    this.legacyClaims = new LegacyLeaderClaims(accountId, options?.legacyClaimIntervalMs ?? 2000)
  }

  get leader(): boolean {
    return this.isLeader
  }

  /**
   * Whether the leader lock is held while this tab doesn't lead, so another tab leads. Just after the
   * lock is granted to this tab, before it learns of that, it also says so.
   */
  async isLockHeldElsewhere(): Promise<boolean> {
    if (this.isLeader || !hasWebLocks() || !navigator.locks.query) return false
    const { held } = await navigator.locks.query()
    return !this.isLeader && (held ?? []).some(lock => lock.name === this.lockName)
  }

  private get lockName(): string {
    return `${getVaultStorageNames().accountPrefixes.leaderLock}${this.accountId}`
  }

  /** Queues for the lock. Without Web Locks every tab leads. */
  async acquire(): Promise<void> {
    this.release()
    this.isReleased = false
    this.lockRetry.reset()

    if (!hasWebLocks()) {
      this.grantLeadership()
      return
    }

    fireAndForget(this.requestLock(false), 'LeaderElection:acquire')
  }

  /**
   * Makes this tab the leader now by stealing the lock from the tab that holds it, which stops leading
   * and queues again. Resolves whether this tab leads once the steal is granted.
   */
  claimLeadership(): Promise<boolean> {
    if (this.isReleased) return Promise.resolve(false)
    if (this.isLeader) return Promise.resolve(true)
    if (!hasWebLocks()) {
      this.grantLeadership()
      return Promise.resolve(true)
    }
    if (!this.claim) {
      this.lockRetryTimer.cancel()
      // A steal can't carry a signal, and a queued request would be granted the lock again after it
      this.request?.abortController.abort()
      this.request = null
      this.claim = this.requestLock(true).finally(() => {
        this.claim = null
      })
    }
    return this.claim
  }

  /** Stops leading or queueing for good */
  release(): void {
    this.isReleased = true
    this.lockRetryTimer.cancel()
    const request = this.request
    this.request = null
    request?.abortController.abort()
    request?.end?.()
    this.revokeLeadership()
  }

  private grantLeadership(): void {
    if (this.isLeader) return
    this.isLeader = true
    this.legacyClaims.start()
    this.callbacks.onLeaderGranted()
  }

  private revokeLeadership(): void {
    if (!this.isLeader) return
    this.isLeader = false
    this.legacyClaims.stop()
    this.callbacks.onLeaderRevoked()
  }

  /**
   * Requests the lock, queued behind its holder or, with `steal`, at once. Resolves whether it was
   * granted, which a queued request only learns once it is.
   */
  private requestLock(steal: boolean): Promise<boolean> {
    const request = new LockRequest()
    this.request = request
    let settle!: (granted: boolean) => void
    const granted = new Promise<boolean>(resolve => {
      settle = resolve
    })
    const options: LockOptions = steal ? { steal: true } : { signal: request.abortController.signal }

    const onGranted = (): Promise<void> | undefined => {
      // Returning at once releases a lock this tab no longer wants
      if (this.request !== request || this.isReleased) return undefined
      request.granted = true
      this.lockRetry.reset()
      const held = new Promise<void>(resolve => {
        request.end = resolve
      })
      this.grantLeadership()
      settle(true)
      return held
    }

    try {
      navigator.locks.request(this.lockName, options, onGranted).then(
        () => settle(false),
        (error: unknown) => {
          settle(false)
          this.onRequestFailed(request, error)
        },
      )
    } catch (error: unknown) {
      settle(false)
      this.onRequestFailed(request, error)
    }
    return granted
  }

  private onRequestFailed(request: LockRequest, error: unknown): void {
    // Ends a hold the browser has already taken away
    request.end?.()
    if (this.request !== request || this.isReleased) return

    if (request.granted && isAbortError(error)) {
      log.info('Another tab took over syncing')
      this.request = null
      this.revokeLeadership()
      fireAndForget(this.requestLock(false), 'LeaderElection:requeue')
      return
    }
    if (request.abortController.signal.aborted) return

    this.request = null
    this.revokeLeadership()
    if (this.lockRetry.canRetry) {
      const delay = this.lockRetry.nextDelay()
      log.error(`Failed to acquire lock (attempt ${this.lockRetry.attempt}/${this.maxLockRetries})`, error)
      this.lockRetryTimer.schedule(delay, () => {
        if (!this.isReleased) {
          fireAndForget(this.requestLock(false), 'LeaderElection:retry')
        }
      })
    } else {
      log.warn(
        `Web Locks permanently failed after ${this.lockRetry.attempt + 1} attempts. Leading without the lock so syncing is not blocked.`,
        error
      )
      this.grantLeadership()
    }
  }
}
