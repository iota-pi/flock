type RetryPredicate = (error: unknown, attempt: number) => boolean

type RetryOptions = {
  shouldRetry?: RetryPredicate
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
}

const DEFAULT_MAX_RETRIES = 4
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500
const DEFAULT_MAX_RETRY_DELAY_MS = 15_000

export class AutomergeSyncTaskQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue<T>(task: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const nextTask = this.tail.then(
      () => this.runTaskWithRetry(task, options),
      () => this.runTaskWithRetry(task, options),
    )

    this.tail = nextTask
      .then(() => undefined)
      .catch(() => undefined)

    return nextTask
  }

  reset(): void {
    this.tail = Promise.resolve()
  }

  private async runTaskWithRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
    const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)
    const initialDelay = Math.max(0, options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS)
    const maxDelay = Math.max(initialDelay, options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS)

    let attempt = 0

    while (true) {
      try {
        return await task()
      } catch (error) {
        attempt += 1

        const canRetry = attempt <= maxRetries && (options.shouldRetry?.(error, attempt) || false)
        if (!canRetry) {
          throw error
        }

        const delay = Math.min(maxDelay, initialDelay * (2 ** (attempt - 1)))
        await this.waitForRetryWindow(delay)
      }
    }
  }

  private waitForRetryWindow(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return Promise.resolve()
    }

    return new Promise(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      const complete = () => {
        if (settled) {
          return
        }

        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }

        if (typeof window !== 'undefined') {
          window.removeEventListener('online', complete)
        }

        resolve()
      }

      timer = setTimeout(complete, delayMs)

      if (typeof window !== 'undefined') {
        window.addEventListener('online', complete, { once: true })
      }
    })
  }
}

export type {
  RetryOptions,
}