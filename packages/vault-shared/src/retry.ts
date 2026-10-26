export interface BackoffOptions {
  /** The delay before the first retry */
  baseMs: number
  /** The most the doubling delay can reach, before jitter */
  maxMs: number
  /** Up to this much random delay is added, so that concurrent retries spread out */
  jitterMs: number
}

/** Jittered exponential backoff: `min(baseMs * 2^attempt, maxMs) + random(0, jitterMs)`, with `attempt` from 0 */
export function getBackoffDelayMs(attempt: number, { baseMs, maxMs, jitterMs }: BackoffOptions): number {
  return Math.min(baseMs * 2 ** attempt, maxMs) + Math.random() * jitterMs
}

/** Waits for the backoff delay of the given attempt (see `getBackoffDelayMs`) */
export function backOff(attempt: number, options: BackoffOptions): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, getBackoffDelayMs(attempt, options)))
}
