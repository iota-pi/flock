/**
 * Safely executes a promise or promise-returning function in a fire-and-forget fashion,
 * ensuring that any unhandled rejection is caught and logged with a diagnostic tag,
 * preventing unhandled promise rejections from crashing the worker or main thread.
 *
 * Can accept either an already initiated Promise or a lazy promise factory (() => Promise<unknown>),
 * catching synchronous errors thrown during invocation.
 *
 * @param promiseOrFactory The promise to execute or function returning a promise.
 * @param tag A descriptive diagnostic tag identifying the subsystem and call site.
 * @param onError Optional error handler callback (e.g. for custom warning or cleanup).
 */
export function fireAndForget(
  promiseOrFactory: Promise<unknown> | (() => Promise<unknown>) | unknown,
  tag: string,
  onError?: (err: unknown) => void,
): void {
  try {
    const promise = typeof promiseOrFactory === 'function' ? (promiseOrFactory as () => unknown)() : promiseOrFactory
    if (promise && typeof (promise as Promise<unknown>).catch === 'function') {
      (promise as Promise<unknown>).catch(err => {
        if (onError) {
          try {
            onError(err)
          } catch (handlerErr) {
            console.error(`[${tag}] Error in fireAndForget onError handler:`, handlerErr)
          }
        } else {
          console.error(`[${tag}] Unhandled async error:`, err)
        }
      })
    }
  } catch (err) {
    if (onError) {
      try {
        onError(err)
      } catch (handlerErr) {
        console.error(`[${tag}] Error in fireAndForget onError handler:`, handlerErr)
      }
    } else {
      console.error(`[${tag}] Unhandled synchronous error:`, err)
    }
  }
}
