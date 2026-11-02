import { createLogger } from './logger'

/**
 * Runs a promise in a fire-and-forget fashion, ensuring that any rejection is caught and
 * logged with a diagnostic tag, preventing unhandled promise rejections from crashing the
 * worker or main thread.
 *
 * @param promise The promise to run.
 * @param tag A descriptive diagnostic tag identifying the subsystem and call site.
 * @param onError Optional error handler callback (e.g. for custom warning or cleanup).
 */
export function fireAndForget(promise: Promise<unknown>, tag: string, onError?: (err: unknown) => void): void {
  promise.catch(err => {
    if (!onError) {
      createLogger(tag).error('Unhandled async error:', err)
      return
    }
    try {
      onError(err)
    } catch (handlerErr) {
      createLogger(tag).error('Error in fireAndForget onError handler:', handlerErr)
    }
  })
}
