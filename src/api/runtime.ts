let authToken = ''
let onSessionExpired: (() => void) | null = null

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

export function getSessionExpiredHandler() {
  return onSessionExpired
}
