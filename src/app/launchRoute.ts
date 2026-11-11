/** The Launch Handler API's queue (Chromium only), which TypeScript's DOM types don't include yet */
export type LaunchQueue = {
  setConsumer: (consumer: (params: { targetURL?: string }) => void) => void
}

/** The in-app route for a URL the installed app was launched with, or null to stay where it is */
export function getLaunchRoute(targetURL: string | undefined, current: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>): string | null {
  if (!targetURL) return null
  const url = new URL(targetURL, current.origin)
  // The migration app is a separate page the main app can't route to
  if (url.origin !== current.origin || /^\/migrate(\/|$)/.test(url.pathname)) return null
  const route = url.pathname + url.search + url.hash
  return route === current.pathname + current.search + current.hash ? null : route
}
