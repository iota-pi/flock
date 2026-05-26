import { useUiStore } from '../state/uiStore'

let authToken = ''
let onSessionExpired: (() => void) | null = null

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

async function trackedRequest<T>(factory: () => Promise<T>): Promise<T> {
  useUiStore.getState().startRequest()
  try {
    const result = await factory()
    useUiStore.getState().finishRequest()
    return result
  } catch (error) {
    useUiStore.getState().finishRequest(
      'A request to the server failed. Please retry later.',
    )
    throw error
  }
}

export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return trackedRequest(async () => {
    const headers = new Headers(init?.headers)
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (authToken) {
      headers.set('Authorization', `Basic ${authToken}`)
    }

    const response = await fetch(input, {
      ...init,
      headers,
    })

    if (response.status === 403 && onSessionExpired) {
      onSessionExpired()
    }

    if (!response.ok) {
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
  })
}

export function setApiAuthToken(nextAuthToken: string) {
  authToken = nextAuthToken
}

export function setApiSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler
}

export function hasApiAuthToken() {
  return !!authToken
}

if (typeof window !== 'undefined' && (window as Window & { Cypress?: unknown }).Cypress) {
  ;(window as Window & { hasApiAuthToken?: typeof hasApiAuthToken }).hasApiAuthToken = hasApiAuthToken
}

export function getApiAuthToken() {
  return authToken
}
