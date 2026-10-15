const LAST_RELOAD_KEY = 'flock-client-outdated-reload'
// Stops a reload loop if the server wants a newer build than the one being served
const MIN_RELOAD_INTERVAL_MS = 5 * 60 * 1000

export const CLIENT_OUTDATED_WARNING = 'This version of Flock is out of date. Reload the page to update it.'

let isHandling = false

function readLastReload(): number {
  try {
    return Number(sessionStorage.getItem(LAST_RELOAD_KEY)) || 0
  } catch {
    return 0
  }
}

function writeLastReload(time: number): void {
  try {
    sessionStorage.setItem(LAST_RELOAD_KEY, String(time))
  } catch {
    // Without session storage, the reload interval can't be enforced across reloads
  }
}

/**
 * The server turned away a write because this build is too old. Fetches the new service worker,
 * which reloads the page once it is installed (registerSW in index.tsx). If no new version turns
 * up, reloads anyway, but at most once every few minutes; after that, asks the user to.
 */
export async function handleClientOutdated(
  { now = Date.now, showWarning }: { now?: () => number, showWarning: (message: string) => void },
): Promise<void> {
  if (isHandling) return
  isHandling = true
  try {
    if (now() - readLastReload() < MIN_RELOAD_INTERVAL_MS) {
      showWarning(CLIENT_OUTDATED_WARNING)
      return
    }
    writeLastReload(now())

    const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
    await registration?.update().catch(() => undefined)
    if (registration?.installing || registration?.waiting) {
      return
    }
    window.location.reload()
  } finally {
    isHandling = false
  }
}
