export type RedirectRouteState = {
  from?: {
    pathname?: string
    search?: string
    hash?: string
  }
}

const DISALLOWED_REDIRECT_PATHS = new Set([
  '/welcome',
  '/login',
  '/signup',
])

export function resolveRedirectRoute(
  state: RedirectRouteState | null | undefined,
  fallbackRoute: string,
  currentPathname?: string,
): string {
  const fromPath = state?.from?.pathname
  if (typeof fromPath !== 'string' || fromPath.length === 0) {
    return fallbackRoute
  }

  if (DISALLOWED_REDIRECT_PATHS.has(fromPath)) {
    return fallbackRoute
  }

  if (currentPathname && fromPath === currentPathname) {
    return fallbackRoute
  }

  const fromSearch = state?.from?.search ?? ''
  const fromHash = state?.from?.hash ?? ''
  return `${fromPath}${fromSearch}${fromHash}`
}
