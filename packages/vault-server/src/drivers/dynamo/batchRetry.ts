import { backOff, type BackoffOptions } from '@vault/shared'
import { isTransientDynamoError } from './dynamoErrors'

const BATCH_BACKOFF: BackoffOptions = { baseMs: 100, maxMs: 5000, jitterMs: 50 }

/**
 * Sends a batch request, then resends whatever DynamoDB leaves unprocessed, and retries transient
 * errors, with jittered exponential backoff. `send` returns the unprocessed part of the request.
 */
export async function sendBatchWithRetry<T>(
  request: T,
  commandName: string,
  unprocessedName: string,
  maxRetries: number,
  send: (request: T) => Promise<T | undefined>,
): Promise<void> {
  let currentRequest = request
  let attempt = 0

  while (true) {
    let unprocessed: T | undefined
    try {
      unprocessed = await send(currentRequest)
    } catch (error) {
      if (!isTransientDynamoError(error)) {
        throw error
      }
      attempt += 1
      if (attempt > maxRetries) {
        throw error
      }
      await backOff(attempt - 1, BATCH_BACKOFF)
      continue
    }

    if (!unprocessed || Object.keys(unprocessed).length === 0) {
      return
    }

    attempt += 1
    if (attempt > maxRetries) {
      throw new Error(`Failed to execute ${commandName} after ${maxRetries} attempts due to DynamoDB unprocessed ${unprocessedName}.`)
    }
    await backOff(attempt - 1, BATCH_BACKOFF)
    currentRequest = unprocessed
  }
}
