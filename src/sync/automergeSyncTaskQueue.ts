type RetryPredicate = (error: unknown, attempt: number) => boolean
type ConnectivityProbe = () => Promise<boolean>

type RetryOptions = {
  shouldRetry?: RetryPredicate
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  connectivityProbe?: ConnectivityProbe
}

const DEFAULT_MAX_RETRIES = 4
const DEFAULT_INITIAL_RETRY_DELAY_MS = 500
const DEFAULT_MAX_RETRY_DELAY_MS = 15_000
const DEFAULT_CONNECTIVITY_PROBE_TIMEOUT_MS = 4_000
const DEFAULT_CONNECTIVITY_PROBE_URL = 'https://www.gstatic.com/generate_204'

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
        await this.waitForRetryWindow(delay, options.connectivityProbe)
      }
    }
  }

  private async waitForRetryWindow(delayMs: number, connectivityProbe?: ConnectivityProbe): Promise<void> {
    if (delayMs <= 0) {
      await this.waitForConnectivityProbe(connectivityProbe)
      return
    }

    await new Promise<void>(resolve => {
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

    await this.waitForConnectivityProbe(connectivityProbe)
  }

  private async waitForConnectivityProbe(connectivityProbe?: ConnectivityProbe): Promise<void> {
    const probe = connectivityProbe || this.defaultConnectivityProbe

    while (true) {
      const reachable = await probe().catch(() => false)
      if (reachable) {
        return
      }

      await new Promise<void>(resolve => {
        setTimeout(resolve, 1_000)
      })
    }
  }

  private async defaultConnectivityProbe(): Promise<boolean> {
    if (typeof fetch === 'undefined') {
      return true
    }

    const abortController = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    try {
      if (abortController) {
        timeoutId = setTimeout(() => {
          abortController.abort()
        }, DEFAULT_CONNECTIVITY_PROBE_TIMEOUT_MS)
      }

      await fetch(DEFAULT_CONNECTIVITY_PROBE_URL, {
        method: 'GET',
        cache: 'no-store',
        mode: 'no-cors',
        signal: abortController?.signal,
      })

      return true
    } catch {
      return false
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }
}

export type {
  RetryOptions,
}