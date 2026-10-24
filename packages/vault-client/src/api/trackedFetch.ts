import { getApiAuthToken, getSessionExpiredHandler } from './runtime'
import { getOnlineState } from '../sync/utils/onlineStatus'

export class ApiHttpError extends Error {
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

function shouldShowServerErrorMessage(error: unknown): boolean {
  if (!getOnlineState()) {
    return false
  }

  if (error instanceof ApiHttpError && (error.status === 401 || error.status === 403)) {
    return false
  }

  return true
}

const SERVER_ERROR_MESSAGE = 'A request to the server failed. Please retry later.'

function stopWithError(stop: (message?: string) => void, error: unknown) {
  if (shouldShowServerErrorMessage(error)) {
    stop(SERVER_ERROR_MESSAGE)
  } else {
    stop()
  }
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/**
 * Whether a failed response carries an error body for the tRPC client to parse. Passing it through
 * (rather than throwing) keeps the server's error code and message, such as CLIENT_OUTDATED.
 */
function hasJsonErrorBody(response: Response): boolean {
  return response.headers.get('content-type')?.includes('application/json') ?? false
}

/**
 * A fetch for the tRPC clients that reports each request's start and end, and whether it failed in
 * a way worth telling the user about. Calls the session-expired handler when the server rejects
 * the session token a request carried (401 or 403).
 *
 * Failed responses with a JSON body are returned for tRPC to turn into an error with the server's
 * code and message. Other failed responses throw `ApiHttpError`.
 */
export function getTrackedFetch(
  start: () => void,
  stop: (message?: string) => void,
) {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    start()

    let response: Response
    const authToken = getApiAuthToken()
    try {
      const headers = new Headers(init?.headers)
      if (authToken) {
        headers.set('Authorization', `Basic ${authToken}`)
      }

      response = await fetch(input, {
        ...init,
        headers,
      })
    } catch (error) {
      stopWithError(stop, error)
      throw error
    }

    // The server rejects an expired or revoked session with 401. It never sends 403, but the handler
    // tries a silent re-login first, so a 403 from something in between costs little. Requests
    // without a token (such as logging in) can also get 401, which says nothing about the session.
    const expiryHandler = getSessionExpiredHandler()
    if (authToken && (response.status === 401 || response.status === 403) && expiryHandler) {
      expiryHandler()
    }

    if (response.ok) {
      stop()
      return response
    }

    const requestUrl = getRequestUrl(input)
    const error = new ApiHttpError({
      status: response.status,
      url: requestUrl,
      message: `Server request failed (${response.status}) for ${requestUrl}`,
    })
    stopWithError(stop, error)

    if (isCypressRuntime() && response.status !== 401 && response.status !== 403) {
      setTimeout(() => {
        throw error
      }, 0)
    }

    if (hasJsonErrorBody(response)) {
      return response
    }
    throw error
  }
}
