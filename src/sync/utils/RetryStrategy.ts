export interface JitterOptions {
  /**
   * Proportion of delay to use for jitter window (e.g., 0.25 means ±25%).
   * Default: 0.25.
   */
  factor?: number
  /**
   * Maximum allowed half-window in milliseconds.
   * Default: 15000.
   */
  maxJitterMs?: number
  /**
   * Random number generator returning [0, 1). Defaults to Math.random.
   */
  randomFn?: () => number
}

export interface RetryStrategyOptions {
  /**
   * Array of delay steps in milliseconds.
   * Defaults to DEFAULT_RETRY_DELAYS.
   */
  delays?: readonly number[]
  /**
   * Optional maximum number of retry attempts allowed before exhaustion.
   */
  maxAttempts?: number
  /**
   * Whether to apply jitter, or specific jitter configuration options.
   */
  jitter?: boolean | JitterOptions
}

export const DEFAULT_RETRY_DELAYS = [2000, 5000, 10000, 30000, 60000] as const
export const DEFAULT_POLL_BACKOFF_DELAYS = [30000, 60000, 120000, 300000] as const

/**
 * Reusable retry strategy encapsulating backoff schedules, symmetric jitter,
 * and maximum attempt counts.
 */
export class RetryStrategy {
  readonly delays: readonly number[]
  readonly maxAttempts?: number
  private readonly jitterOptions: JitterOptions | null
  private currentAttempt = 0

  constructor(options: RetryStrategyOptions = {}) {
    this.delays = options.delays ?? DEFAULT_RETRY_DELAYS
    this.maxAttempts = options.maxAttempts
    if (options.jitter === true) {
      this.jitterOptions = {}
    } else if (typeof options.jitter === 'object' && options.jitter !== null) {
      this.jitterOptions = options.jitter
    } else {
      this.jitterOptions = null
    }
  }

  get attempt(): number {
    return this.currentAttempt
  }

  set attempt(val: number) {
    this.currentAttempt = Math.max(0, val)
  }

  get canRetry(): boolean {
    if (this.maxAttempts === undefined) {
      return true
    }
    return this.currentAttempt < this.maxAttempts
  }

  get isExhausted(): boolean {
    return !this.canRetry
  }

  /**
   * Returns the base delay for the current attempt index (clamped to the last delay).
   */
  get currentBaseDelay(): number {
    return this.getBaseDelay(this.currentAttempt)
  }

  /**
   * Returns the current delay, applying jitter if configured.
   */
  get currentDelay(): number {
    const base = this.currentBaseDelay
    return this.jitterOptions ? RetryStrategy.applyJitter(base, this.jitterOptions) : base
  }

  /**
   * Returns the base delay (without advancing or applying jitter) for a specific attempt index.
   */
  getBaseDelay(attemptIndex: number): number {
    if (this.delays.length === 0) return 0
    const clampedIndex = Math.min(Math.max(0, attemptIndex), this.delays.length - 1)
    return this.delays[clampedIndex]
  }

  /**
   * Computes delay for a specific attempt index, optionally applying jitter.
   */
  getDelay(attemptIndex: number, options?: { applyJitter?: boolean }): number {
    const base = this.getBaseDelay(attemptIndex)
    const shouldJitter = options?.applyJitter ?? (this.jitterOptions !== null)
    if (shouldJitter) {
      return RetryStrategy.applyJitter(base, this.jitterOptions ?? undefined)
    }
    return base
  }

  /**
   * Computes the delay for the current attempt (applying jitter if configured)
   * and increments the attempt counter.
   */
  nextDelay(): number {
    const delay = this.currentDelay
    this.currentAttempt += 1
    return delay
  }

  /**
   * Increments the attempt counter, optionally clamping to the last delay index.
   * Useful for backoff stepping (e.g. SyncOrchestrator).
   */
  increment(options?: { clampToLast?: boolean }): number {
    if (options?.clampToLast) {
      this.currentAttempt = Math.min(this.currentAttempt + 1, Math.max(0, this.delays.length - 1))
    } else {
      this.currentAttempt += 1
    }
    return this.currentAttempt
  }

  /**
   * Resets the attempt counter to 0.
   */
  reset(): void {
    this.currentAttempt = 0
  }

  /**
   * Applies jitter to a given delay using the strategy's configured jitter settings (or default settings).
   */
  applyJitter(delayMs: number): number {
    return RetryStrategy.applyJitter(delayMs, this.jitterOptions ?? undefined)
  }

  /**
   * Static helper to apply symmetric jitter centered around target delay.
   * Formula matches SyncOrchestrator:
   * jitterWindow = min(maxJitterMs, floor(delayMs * factor))
   * offset in [-floor(jitterWindow/2), ceil(jitterWindow/2)]
   */
  static applyJitter(delayMs: number, options: JitterOptions = {}): number {
    const factor = options.factor ?? 0.25
    const maxJitterMs = options.maxJitterMs ?? 15000
    const randomFn = options.randomFn ?? Math.random

    const jitterWindow = Math.min(maxJitterMs, Math.floor(delayMs * factor))
    if (jitterWindow <= 0) {
      return delayMs
    }

    const offset = Math.floor(randomFn() * (jitterWindow + 1)) - Math.floor(jitterWindow / 2)
    return Math.max(0, delayMs + offset)
  }

  /**
   * Static helper to compute delay for a given schedule and attempt.
   */
  static computeDelay(
    delays: readonly number[],
    attempt: number,
    options?: { jitter?: boolean | JitterOptions }
  ): number {
    if (delays.length === 0) return 0
    const index = Math.min(Math.max(0, attempt), delays.length - 1)
    const base = delays[index]
    if (options?.jitter) {
      const jitterOpts = typeof options.jitter === 'object' ? options.jitter : undefined
      return RetryStrategy.applyJitter(base, jitterOpts)
    }
    return base
  }
}
