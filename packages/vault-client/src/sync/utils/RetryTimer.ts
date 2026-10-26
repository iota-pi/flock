/**
 * Holds at most one pending retry. Scheduling replaces any retry already pending, and the timer is
 * cleared before its callback runs, so the callback can schedule the next one.
 */
export class RetryTimer {
  private timer: ReturnType<typeof setTimeout> | null = null

  /** Whether a retry is waiting to run */
  get isPending(): boolean {
    return this.timer !== null
  }

  /** Runs `callback` after `delayMs`, replacing any retry already pending */
  schedule(delayMs: number, callback: () => void): void {
    this.cancel()
    const timer = setTimeout(() => {
      if (this.timer === timer) {
        this.timer = null
      }
      callback()
    }, Math.max(0, delayMs))
    this.timer = timer
  }

  /** Drops the pending retry, if any */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
