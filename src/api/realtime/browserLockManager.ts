type LockLifecycleCallbacks = {
  startLeader: () => void
  stopLeader: () => void
}

export class BrowserLockManager {
  private readonly abortController = typeof AbortController !== 'undefined'
    ? new AbortController()
    : null

  private releaseLeadership: (() => void) | null = null
  private stopLeader: (() => void) | null = null
  private stopped = false
  private leaderActive = false

  constructor(private readonly lockName: string) {}

  start({ startLeader, stopLeader }: LockLifecycleCallbacks): void {
    const safeStartLeader = () => {
      if (this.leaderActive) {
        return
      }

      this.leaderActive = true
      startLeader()
    }

    const safeStopLeader = () => {
      if (!this.leaderActive) {
        return
      }

      this.leaderActive = false
      stopLeader()
    }

    this.stopLeader = safeStopLeader

    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      void navigator.locks.request(this.lockName, {
        signal: this.abortController?.signal,
      }, async () => {
        if (this.stopped) {
          return
        }

        safeStartLeader()

        await new Promise<void>(resolve => {
          this.releaseLeadership = () => {
            if (!this.releaseLeadership) {
              return
            }

            this.releaseLeadership = null
            safeStopLeader()
            resolve()
          }
        })
      }).catch(() => {
        safeStopLeader()
      })
      return
    }

    safeStartLeader()
    this.releaseLeadership = () => {
      if (!this.releaseLeadership) {
        return
      }

      this.releaseLeadership = null
      safeStopLeader()
    }
  }

  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    if (this.releaseLeadership) {
      this.releaseLeadership()
    } else {
      this.stopLeader?.()
    }

    this.abortController?.abort()
  }
}