import { getApiAuthToken, getSessionExpiredHandler } from './runtime'

class ApiHttpError extends Error {
  readonly status: number
  readonly url: string

  constructor(params: { status: number; url: string; message?: string }) {
    super(params.message || `Request failed with status ${params.status}`)
    this.name = 'ApiHttpError'
    this.status = params.status
    this.url = params.url
  }
}

function isCypressRuntime(): boolean {
  return typeof window !== 'undefined' && !!(window as Window & { Cypress?: unknown }).Cypress
}

async function trackedRequest<T>(
  factory: () => Promise<T>,
  start: () => void,
  stop: (message?: string) => void,
): Promise<T> {
  start()
  try {
    const result = await factory()
    stop()
    return result
  } catch (error) {
    stop('A request to the server failed. Please retry later.')
    throw error
  }
}

export function getTrackedFetch(
  start: () => void,
  stop: (message?: string) => void,
) {
  return (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => trackedRequest(
    async () => {
      const headers = new Headers(init?.headers)
      const authToken = getApiAuthToken()
      if (authToken) {
        headers.set('Authorization', `Basic ${authToken}`)
      }

      const response = await fetch(input, {
        ...init,
        headers,
      })

      const expiryHandler = getSessionExpiredHandler()
      if (response.status === 403 && expiryHandler) {
        expiryHandler()
      }

      if (!response.ok) {
        const requestUrl = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
        const error = new ApiHttpError({
          status: response.status,
          url: requestUrl,
          message: `Server request failed (${response.status}) for ${requestUrl}`,
        })

        if (isCypressRuntime()) {
          setTimeout(() => {
            throw error
          }, 0)
        }

        throw error
      }

      return response
    },
    start,
    stop,
  )
}
