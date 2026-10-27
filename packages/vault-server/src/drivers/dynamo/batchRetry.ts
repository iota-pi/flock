import { backOff, type BackoffOptions } from '@vault/shared'

const BATCH_BACKOFF: BackoffOptions = { baseMs: 100, maxMs: 5000, jitterMs: 50 }
export const BATCH_MAX_RETRIES = 5

export interface BatchRetryOptions<T> {
  request: T
  /** Names the command and the unprocessed part of its response in the error once retries run out */
  commandName: string
  unprocessedName: string
  /** Sends a request and returns its unprocessed part */
  send: (request: T) => Promise<T | undefined>
}

/**
 * Sends a batch request, then resends whatever DynamoDB leaves unprocessed with jittered exponential
 * backoff. The SDK doesn't resend unprocessed keys or items, so this does.
 *
 * Errors that `send` throws propagate immediately: the SDK client has already retried throttling,
 * 5xx and network errors itself, so retrying them here too would multiply the attempts.
 */
export async function sendBatchWithRetry<T>(
  { request, commandName, unprocessedName, send }: BatchRetryOptions<T>,
): Promise<void> {
  let currentRequest = request

  for (let attempt = 0; ; attempt += 1) {
    const unprocessed = await send(currentRequest)
    if (!unprocessed || Object.keys(unprocessed).length === 0) {
      return
    }

    if (attempt >= BATCH_MAX_RETRIES) {
      throw new Error(`Failed to execute ${commandName} after ${BATCH_MAX_RETRIES} retries due to DynamoDB unprocessed ${unprocessedName}.`)
    }
    await backOff(attempt, BATCH_BACKOFF)
    currentRequest = unprocessed
  }
}
