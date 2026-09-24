export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * Determines whether an unknown error is an AbortError or abort-related exception.
 */
export function isAbortError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof AbortError) return true
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true
  return false
}

/**
 * Asserts that an operation is still alive and not aborted.
 * Throws a well-typed AbortError if the signal is aborted or if the alive condition fails.
 *
 * @param signal Optional AbortSignal to check
 * @param isAlive Optional boolean or predicate function indicating operational liveness
 * @param message Optional error message
 */
export function checkAlive(
  signal?: AbortSignal | null,
  isAlive: boolean | (() => boolean) = true,
  message = 'Operation aborted'
): void {
  const alive = typeof isAlive === 'function' ? isAlive() : isAlive
  if (signal?.aborted || !alive) {
    let abortMsg = message
    if (signal?.aborted) {
      if (signal.reason instanceof Error) {
        abortMsg = signal.reason.message || message
      } else if (typeof signal.reason === 'string') {
        abortMsg = signal.reason
      }
    }
    const err = new AbortError(abortMsg)
    if (signal?.reason && typeof signal.reason === 'object' && signal.reason !== err) {
      err.cause = signal.reason
    }
    throw err
  }
}
