/** Time allowed for a response to start arriving, on top of the time to send the request body */
const BASE_TIMEOUT_MS = 30_000
/** Slowest upload speed to allow for, so large uploads on slow connections still finish */
const MIN_UPLOAD_BYTES_PER_SECOND = 10_000

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    // "Network error" so the sync error classifier and Sentry filters treat it as one
    super(`Network error: no response after ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'RequestTimeoutError'
  }
}

function getBodySize(body: BodyInit | null | undefined): number {
  if (typeof body === 'string') return body.length
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  return 0
}

/**
 * Wraps a fetch so a request fails if its response hasn't started arriving in time, as happens on a
 * stalled connection that the browser still reports as online. The timer stops once the response
 * headers arrive, so slowly downloading a large response is fine. Larger uploads get more time.
 */
export function withRequestTimeout(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const timeoutMs = BASE_TIMEOUT_MS + (getBodySize(init?.body) / MIN_UPLOAD_BYTES_PER_SECOND) * 1000
    const controller = new AbortController()
    const callerSignal = init?.signal
    const abortFromCaller = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) {
      abortFromCaller()
    } else {
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new RequestTimeoutError(timeoutMs))
    }, timeoutMs)

    try {
      return await fetchImpl(input, { ...init, signal: controller.signal })
    } catch (error) {
      if (timedOut) {
        throw new RequestTimeoutError(timeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
  }
}
