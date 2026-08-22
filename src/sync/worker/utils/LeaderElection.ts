export class LeaderElection {
  private releaseLeadershipLock: (() => void) | null = null
  private abortController: AbortController | null = null
  private isLeader = false

  constructor(
    private accountId: string,
    private callbacks: {
      onLeaderGranted: () => void
      onLeaderRevoked: () => void
    }
  ) {}

  private grantLeadership(): void {
    if (!this.isLeader) {
      this.isLeader = true
      this.callbacks.onLeaderGranted()
    }
  }

  private revokeLeadership(): void {
    if (this.isLeader) {
      this.isLeader = false
      this.callbacks.onLeaderRevoked()
    }
  }

  async acquire(): Promise<void> {
    this.release()

    if (typeof navigator === 'undefined' || !navigator.locks) {
      this.grantLeadership()
      return
    }

    const lockName = `flock-sync-leader-${this.accountId}`
    const abortController = new AbortController()
    this.abortController = abortController

    void navigator.locks
      .request(lockName, { signal: abortController.signal }, async () => {
        this.grantLeadership()

        return new Promise<void>(resolve => {
          this.releaseLeadershipLock = () => {
            this.revokeLeadership()
            resolve()
          }
        })
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          return
        }
        if ((err as { name?: string })?.name === 'AbortError') {
          return
        }
        console.error('[LeaderElection] Failed to acquire lock, falling back to leader mode', err)
        this.grantLeadership()
      })
  }

  release(): void {
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
  }
}
