import { isRateLimitedError } from '@vault/shared'
import { RetryStrategy } from '../sync/utils/RetryStrategy'
import { classifySyncError } from '../sync/utils/errorClassifier'
import { createLogger } from '../sync/utils/logger'
import { REQUEST_RETRY_DELAYS } from './util'

const log = createLogger('requestRetry')

/** Whether a failed request might succeed if sent again. A rate limit won't lift in time to help. */
export function isTransientRequestError(error: unknown): boolean {
  const { isNetwork, isServerError, isAuth } = classifySyncError(error)
  return (isNetwork || isServerError) && !isAuth && !isRateLimitedError(error)
}

/**
 * Sends a request, retrying transient failures (see `isTransientRequestError`). `stillWanted` stops
 * the retries once the result is no longer needed.
 */
export function retryTransientFailures<T>(
  description: string,
  request: () => Promise<T>,
  { stillWanted = () => true }: { stillWanted?: () => boolean } = {},
): Promise<T> {
  return RetryStrategy.executeWithRetry(request, {
    delays: REQUEST_RETRY_DELAYS,
    shouldRetry: error => stillWanted() && isTransientRequestError(error),
    onRetry: (error, attempt) => {
      log.warn(`Failed to ${description} (attempt ${attempt}); retrying:`, error)
    },
  })
}
