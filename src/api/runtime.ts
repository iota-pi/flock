import { useUiStore } from '../state/uiStore'

let authToken = ''
let onSessionExpired: (() => void) | null = null

function startRequest() {
  useUiStore.getState().startRequest()
}

function finishRequest(error?: string) {
  useUiStore.getState().finishRequest(error)
}

export async function trackedRequest<T>(factory: () => Promise<T>): Promise<T> {
  startRequest()
  try {
    const result = await factory()
    finishRequest()
    return result
  } catch (error) {
    finishRequest('A request to the server failed. Please retry later.')
    throw error
  }
}

export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return trackedRequest(async () => {
    const headers = new Headers(init?.headers)
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
      finishRequest('A request to the server failed. Please retry later.')
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

export function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    return
  }
  console.error(error)
  useUiStore.getState().setUi({
    message: {
      message,
      severity: 'error',
    },
  })
}