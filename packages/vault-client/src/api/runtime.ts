let authToken = ''
let onSessionExpired: (() => void) | null = null

export function setApiAuthToken(nextAuthToken: string) {
  authToken = nextAuthToken
}

export function setApiSessionExpiredHandler(handler: (() => void) | null) {
  onSessionExpired = handler
}

export function hasApiAuthToken() {
  return !!authToken
}

export function getApiAuthToken() {
  return authToken
}

export function getSessionExpiredHandler() {
  return onSessionExpired
}
