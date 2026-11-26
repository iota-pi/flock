import { ActiveTabTakenError, activeTabLockName, hasWebLocks } from '../shared/activeTab'
import { isAbortError } from '../utils/abort'
import { createLogger } from '../utils/logger'

const log = createLogger('ActiveTabLock')

export interface ActiveTabLockOptions {
  /** Another tab stole the lock, so this engine must stop. Called at most once. */
  onDisplaced: () => void
}

/**
 * Holds the account's active-tab lock for as long as this engine runs (see "One active tab" in
 * docs/sync-design.md). The main thread clears the lock before starting the worker
 * (`takeOverActiveTab`), so `acquire` doesn't queue: it fails if another tab got there first. A tab
 * that takes over later steals the lock, and the browser rejects this tab's request with an
 * `AbortError`, which is when this engine learns it has been displaced.
 */
export class ActiveTabLock {
  private releaseHold: (() => void) | null = null
  private held = false
  private released = false

  constructor(
    private readonly accountId: string,
    private readonly options: ActiveTabLockOptions,
  ) {}

  /** Takes the lock if no other tab holds it, or throws `ActiveTabTakenError`. Without Web Locks it does nothing. */
  async acquire(): Promise<void> {
    if (!hasWebLocks()) return
    const granted = Promise.withResolvers<boolean>()
    const hold = Promise.withResolvers<void>()
    this.releaseHold = hold.resolve
    navigator.locks.request(activeTabLockName(this.accountId), { ifAvailable: true }, lock => {
      // Returning at once releases a lock this engine no longer wants
      if (!lock || this.released) {
        granted.resolve(false)
        return undefined
      }
      this.held = true
      granted.resolve(true)
      return hold.promise
    }).then(
      () => granted.resolve(false),
      (error: unknown) => {
        granted.resolve(false)
        this.onLost(error)
      },
    )
    if (!(await granted.promise)) {
      throw new ActiveTabTakenError()
    }
  }

  /** Lets go of the lock, once this engine has stopped */
  release(): void {
    this.released = true
    this.held = false
    this.releaseHold?.()
    this.releaseHold = null
  }

  private onLost(error: unknown): void {
    const wasHeld = this.held
    this.held = false
    if (!wasHeld || this.released) return
    if (!isAbortError(error)) {
      log.error('The active-tab lock failed', error)
    }
    log.info('Another tab took over this account')
    this.released = true
    this.options.onDisplaced()
  }
}
