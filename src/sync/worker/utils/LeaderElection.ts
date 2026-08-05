export class LeaderElection {
  private releaseLeadershipLock: (() => void) | null = null

  constructor(
    private accountId: string,
    private callbacks: {
      onLeaderGranted: () => void
      onLeaderRevoked: () => void
    }
  ) {}

  async acquire(): Promise<void> {
    this.release()

    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.callbacks.onLeaderGranted()
      return
    }

    const lockName = `flock-sync-leader-${this.accountId}`

    void navigator.locks.request(lockName, async () => {
      this.callbacks.onLeaderGranted()

      return new Promise<void>(resolve => {
        this.releaseLeadershipLock = () => {
          this.callbacks.onLeaderRevoked()
          resolve()
        }
      })
    }).catch(err => {
      console.error('[LeaderElection] Failed to acquire lock, falling back to leader mode', err)
      this.callbacks.onLeaderGranted()
    })
  }

  release(): void {
    if (this.releaseLeadershipLock) {
      this.releaseLeadershipLock()
      this.releaseLeadershipLock = null
    } else {
      this.callbacks.onLeaderRevoked()
    }
  }
}
