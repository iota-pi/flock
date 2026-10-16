import { RequestTimeoutError, withRequestTimeout } from './requestTimeout'
import { classifySyncError } from '../sync/worker/utils/errorClassifier'

function hangingFetch() {
  return vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
}

describe('withRequestTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the response when it arrives in time', async () => {
    const response = new Response('ok')
    const timedFetch = withRequestTimeout(async () => response)

    await expect(timedFetch('http://vault.test')).resolves.toBe(response)
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

  it('is classified as a network failure rather than an abort', () => {
    const classified = classifySyncError(new RequestTimeoutError(30_000))
    expect(classified.isAbort).toBe(false)
    expect(classified.isNetwork).toBe(true)
  })
})
