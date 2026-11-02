/** Time allowed for a response to start arriving, on top of the time to send the request body */
const BASE_TIMEOUT_MS = 30_000
/** Slowest upload speed to allow for, so large uploads on slow connections still finish */
const MIN_UPLOAD_BYTES_PER_SECOND = 10_000
/** Slowest download speed to allow for, so large responses on slow connections still finish */
const MIN_DOWNLOAD_BYTES_PER_SECOND = 10_000
/** Statuses whose responses can't be constructed with a body */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

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

function getContentLength(response: Response): number {
  const length = Number(response.headers.get('content-length'))
  return Number.isFinite(length) && length > 0 ? length : 0
}

/**
 * Wraps a fetch so a request fails if it stalls, as happens on a connection that the browser still
 * reports as online. The response must start arriving in time (larger uploads get more time), and
 * then its body must finish arriving in time (larger responses get more time). The body is read in
 * full before the response is returned, so the caller's abort and the timeout both cover it.
 */
export function withRequestTimeout(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const callerSignal = init?.signal
    const abortFromCaller = () => controller.abort(callerSignal?.reason)
    if (callerSignal?.aborted) {
      abortFromCaller()
    } else {
      callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    }

    let timedOutAfterMs: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const startTimer = (timeoutMs: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOutAfterMs = timeoutMs
        controller.abort(new RequestTimeoutError(timeoutMs))
      }, timeoutMs)
    }

    try {
      startTimer(BASE_TIMEOUT_MS + (getBodySize(init?.body) / MIN_UPLOAD_BYTES_PER_SECOND) * 1000)
      const response = await fetchImpl(input, { ...init, signal: controller.signal })

      startTimer(BASE_TIMEOUT_MS + (getContentLength(response) / MIN_DOWNLOAD_BYTES_PER_SECOND) * 1000)
      const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer()
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      if (timedOutAfterMs !== null) {
        throw new RequestTimeoutError(timedOutAfterMs)
      }
      throw error
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
    }
  }
}
