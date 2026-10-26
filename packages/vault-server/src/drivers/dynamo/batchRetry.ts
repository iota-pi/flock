import { isTransientDynamoError } from './dynamoErrors'

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
  let delayMs = 100

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
      await backOff(delayMs)
      delayMs = Math.min(delayMs * 2, 5000)
      continue
    }

    if (!unprocessed || Object.keys(unprocessed).length === 0) {
      return
    }

    attempt += 1
    if (attempt > maxRetries) {
      throw new Error(`Failed to execute ${commandName} after ${maxRetries} attempts due to DynamoDB unprocessed ${unprocessedName}.`)
    }
    await backOff(delayMs)
    delayMs = Math.min(delayMs * 2, 5000)
    currentRequest = unprocessed
  }
}

function backOff(delayMs: number): Promise<void> {
  const jitter = Math.random() * 50
  return new Promise(resolve => setTimeout(resolve, delayMs + jitter))
}
