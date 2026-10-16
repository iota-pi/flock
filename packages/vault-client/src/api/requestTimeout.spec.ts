import { RequestTimeoutError, withRequestTimeout } from './requestTimeout'
import { classifySyncError } from '../sync/worker/utils/errorClassifier'

function hangingFetch() {
  return vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
}

/** A fetch whose response headers arrive at once but whose body never finishes */
function stallingBodyFetch(headers?: HeadersInit) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('partial'))
        init?.signal?.addEventListener('abort', () => streamController.error(init.signal?.reason))
      },
    })
    return new Response(body, { headers })
  })
}

describe('withRequestTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the response when it arrives in time', async () => {
    const timedFetch = withRequestTimeout(async () => new Response('ok', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))

    const response = await timedFetch('http://vault.test')
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.text()).toBe('ok')
  })

  it('returns bodiless responses', async () => {
    const timedFetch = withRequestTimeout(async () => new Response(null, { status: 204 }))

    const response = await timedFetch('http://vault.test')
    expect(response.status).toBe(204)
  })

  it('fails a request that gets no response', async () => {
    const timedFetch = withRequestTimeout(hangingFetch())

    const request = timedFetch('http://vault.test').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await request).toBeInstanceOf(RequestTimeoutError)
  })

  it('allows more time for larger uploads', async () => {
    const timedFetch = withRequestTimeout(hangingFetch())

    let settled = false
    const request = timedFetch('http://vault.test', { method: 'POST', body: 'x'.repeat(100_000) })
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(await request).toBeInstanceOf(RequestTimeoutError)
  })

  it("passes on the caller's abort", async () => {
    const timedFetch = withRequestTimeout(hangingFetch())
    const controller = new AbortController()

    const request = timedFetch('http://vault.test', { signal: controller.signal })
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails a request whose response body stops arriving', async () => {
    const timedFetch = withRequestTimeout(stallingBodyFetch())

    const request = timedFetch('http://vault.test').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await request).toBeInstanceOf(RequestTimeoutError)
  })

  it('allows more time for larger responses', async () => {
    const timedFetch = withRequestTimeout(stallingBodyFetch({ 'content-length': '100000' }))

    let settled = false
    const request = timedFetch('http://vault.test')
      .catch((error: unknown) => error)
      .finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(await request).toBeInstanceOf(RequestTimeoutError)
  })

  it("passes on the caller's abort while the body arrives", async () => {
    const timedFetch = withRequestTimeout(stallingBodyFetch())
    const controller = new AbortController()

    const request = timedFetch('http://vault.test', { signal: controller.signal }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new DOMException('Aborted', 'AbortError'))

    expect(await request).toMatchObject({ name: 'AbortError' })
  })

  it('is classified as a network failure rather than an abort', () => {
    const classified = classifySyncError(new RequestTimeoutError(30_000))
    expect(classified.isAbort).toBe(false)
    expect(classified.isNetwork).toBe(true)
  })
})
