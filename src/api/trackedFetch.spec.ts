import type { Mock } from 'vitest'
import { getTrackedFetch, ApiHttpError } from './trackedFetch'
import * as runtime from './runtime'
import * as onlineStatus from '../utils/onlineStatus'

describe('trackedFetch', () => {
  const originalFetch = global.fetch
  let startMock: Mock<() => void>
  let stopMock: Mock<(message?: string) => void>

  beforeEach(() => {
    startMock = vi.fn<() => void>()
    stopMock = vi.fn<(message?: string) => void>()
    vi.spyOn(onlineStatus, 'getOnlineState').mockReturnValue(true)
    vi.spyOn(runtime, 'getApiAuthToken').mockReturnValue('')
    vi.spyOn(runtime, 'getSessionExpiredHandler').mockReturnValue(null)
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('tracks successful requests without error messages', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const trackedFetch = getTrackedFetch(startMock, stopMock)
    const response = await trackedFetch('https://example.com/api')

    expect(startMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith()
    expect(response.status).toBe(200)
  })

  it('suppresses server error message on 401 Unauthorized (incorrect password)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))

    const trackedFetch = getTrackedFetch(startMock, stopMock)

    await expect(trackedFetch('https://example.com/trpc/accounts.login')).rejects.toThrow(ApiHttpError)
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith()
  })

  it('suppresses server error message on 403 Forbidden (session expired)', async () => {
    const expiredHandler = vi.fn()
    vi.spyOn(runtime, 'getSessionExpiredHandler').mockReturnValue(expiredHandler)
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))

    const trackedFetch = getTrackedFetch(startMock, stopMock)

    await expect(trackedFetch('https://example.com/trpc/items.get')).rejects.toThrow(ApiHttpError)
    expect(expiredHandler).toHaveBeenCalledTimes(1)
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith()
  })

  it('shows server error message on 500 Internal Server Error when online', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Server Error' }), { status: 500 }))

    const trackedFetch = getTrackedFetch(startMock, stopMock)

    await expect(trackedFetch('https://example.com/api')).rejects.toThrow(ApiHttpError)
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith('A request to the server failed. Please retry later.')
  })

  it('suppresses server error message when device is offline', async () => {
    vi.spyOn(onlineStatus, 'getOnlineState').mockReturnValue(false)
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    const trackedFetch = getTrackedFetch(startMock, stopMock)

    await expect(trackedFetch('https://example.com/api')).rejects.toThrow(TypeError)
    expect(startMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith()
  })

  it('attaches basic auth header if authToken is present', async () => {
    vi.spyOn(runtime, 'getApiAuthToken').mockReturnValue('my-auth-token')
    global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    const trackedFetch = getTrackedFetch(startMock, stopMock)
    await trackedFetch('https://example.com/api')

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
    const callHeaders = (global.fetch as any).mock.calls[0][1].headers as Headers
    expect(callHeaders.get('Authorization')).toBe('Basic my-auth-token')
  })
})
