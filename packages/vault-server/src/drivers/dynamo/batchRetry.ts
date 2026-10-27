import { backOff, type BackoffOptions } from '@vault/shared'
import { isTransientDynamoError } from './dynamoErrors'

const BATCH_BACKOFF: BackoffOptions = { baseMs: 100, maxMs: 5000, jitterMs: 50 }
const BATCH_MAX_RETRIES = 5

export interface BatchRetryOptions<T> {
  request: T
  /** Names the command and the unprocessed part of its response in the error once retries run out */
  commandName: string
  unprocessedName: string
  /** Sends a request and returns its unprocessed part */
  send: (request: T) => Promise<T | undefined>
}

/**
 * Sends a batch request, then resends whatever DynamoDB leaves unprocessed, and retries transient
 * errors, with jittered exponential backoff.
 */
export async function sendBatchWithRetry<T>(
  { request, commandName, unprocessedName, send }: BatchRetryOptions<T>,
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
      if (attempt > BATCH_MAX_RETRIES) {
        throw error
      }
      await backOff(attempt - 1, BATCH_BACKOFF)
      continue
    }

    if (!unprocessed || Object.keys(unprocessed).length === 0) {
      return
    }

    attempt += 1
    if (attempt > BATCH_MAX_RETRIES) {
      throw new Error(`Failed to execute ${commandName} after ${BATCH_MAX_RETRIES} attempts due to DynamoDB unprocessed ${unprocessedName}.`)
    }
    await backOff(attempt - 1, BATCH_BACKOFF)
    currentRequest = unprocessed
  }
}
