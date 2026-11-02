export class AbortError extends Error {
  constructor(message = 'Operation aborted', options?: ErrorOptions) {
    super(message, options)
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
 * The error `signal` aborted with: its reason when that is an Error, otherwise an AbortError carrying
 * a string reason or `message`
 */
export function abortReason(signal: AbortSignal, message = 'Operation aborted'): Error {
  const { reason } = signal
  if (reason instanceof Error) return reason
  return new AbortError(typeof reason === 'string' ? reason : message)
}

/** An AbortError for an aborted signal, keeping any other error it aborted with as the cause */
function toAbortError(signal: AbortSignal, message?: string): AbortError {
  const reason = abortReason(signal, message)
  if (reason instanceof AbortError) return reason
  return new AbortError(reason.message || message, { cause: reason })
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
  if (signal?.aborted) {
    throw toAbortError(signal, message)
  }
  const alive = typeof isAlive === 'function' ? isAlive() : isAlive
  if (!alive) {
    throw new AbortError(message)
  }
}

/**
 * Settles with `promise`, or rejects with an AbortError once `signal` aborts, for a caller that stops
 * waiting on work it can't cancel (such as a call to a worker that has been terminated, which never
 * settles, or a run that other callers share).
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(toAbortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Runs `fn` with a signal that aborts after `ms` (with `reason`, when given) or with `signal`, whichever
 * comes first. It times out with `setTimeout` rather than `AbortSignal.timeout`, which Vitest's fake
 * timers don't drive.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; reason?: unknown } = {},
): Promise<T> {
  const timeout = new AbortController()
  const timeoutId = setTimeout(() => timeout.abort(options.reason), ms)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  try {
    return await fn(signal)
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Resolves after `ms`, or rejects with the signal's `abortReason` as soon as it aborts */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    const target: AbortSignal = signal
    const timer = setTimeout(() => {
      target.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortReason(target))
    }
    target.addEventListener('abort', onAbort, { once: true })
  })
}
