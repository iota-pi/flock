import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { useAppStore } from '../state/store'

type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

/*
 * Applying a new build reloads the page, which forgets the vault keys and locks the app. So a new
 * service worker only takes over while nobody is logged in: on the lock or login screen, or once
 * the app locks. A logged-in session therefore keeps running the build it started with, whose
 * lazily loaded chunks are still in the old service worker's precache.
 *
 * The new service worker takes over every tab at once, and each tab reloads when it does. So each
 * tab holds SESSION_LOCK (shared) while it is logged in or logging in, and an update is only applied
 * once no tab holds it.
 */

export const SESSION_LOCK = 'flock-session'
const BLOCKED_RETRY_MS = 30_000

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null
let registration: ServiceWorkerRegistration | undefined
let updatePending = false
let updateRequested = false
let forceUpdate = false
let loginsInProgress = 0
let sessionLock: { release: () => void } | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function getLocks(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined
}

function canApplyUpdate(): boolean {
  return forceUpdate || (!useAppStore.getState().loggedIn && loginsInProgress === 0)
}

/** Holds SESSION_LOCK while this tab is logged in or logging in, so other tabs don't update under it */
function syncSessionLock(): void {
  const wanted = useAppStore.getState().loggedIn || loginsInProgress > 0
  const locks = getLocks()
  if (wanted && !sessionLock && locks) {
    let release: () => void = () => {}
    const released = new Promise<void>(resolve => { release = resolve })
    sessionLock = { release }
    locks.request(SESSION_LOCK, { mode: 'shared' }, () => released).catch(() => undefined)
  } else if (!wanted && sessionLock) {
    sessionLock.release()
    sessionLock = null
  }
}

function applyNow(): void {
  updatePending = false
  updateRequested = false
  useAppStore.getState().setAppUpdateReady(false)
  void updateServiceWorker?.(true)
}

function retryWhenUnblocked(): void {
  if (retryTimer !== null) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    applyPendingUpdate()
  }, BLOCKED_RETRY_MS)
}

function applyPendingUpdate(): void {
  if (!updatePending || !updateServiceWorker || (!updateRequested && !forceUpdate) || !canApplyUpdate()) return

  // A forced update applies regardless: other tabs are running the same unusable build
  const locks = getLocks()
  if (forceUpdate || !locks) {
    applyNow()
    return
  }

  locks.request(SESSION_LOCK, { mode: 'exclusive', ifAvailable: true }, lock => {
    if (!lock) {
      // Another tab is logged in
      retryWhenUnblocked()
      return
    }
    if (updatePending && canApplyUpdate()) {
      applyNow()
    }
  }).catch(() => undefined)
}

/** Registers the service worker. Call once at startup with `registerSW` from `virtual:pwa-register`. */
export function registerAppUpdates(registerSW: RegisterSW): void {
  updateServiceWorker = registerSW({
    onNeedRefresh() {
      updatePending = true
      useAppStore.getState().setAppUpdateReady(true)
      applyPendingUpdate()
    },
    onOfflineReady() {
      console.info('[PWA] App is ready to work offline.')
    },
    onRegisteredSW(_url, swRegistration) {
      registration = swRegistration
    },
  })

  syncSessionLock()
  useAppStore.subscribe((state, previous) => {
    if (state.loggedIn !== previous.loggedIn) {
      syncSessionLock()
    }
    if (previous.loggedIn && !state.loggedIn) {
      applyPendingUpdate()
    }
  })
}

/** Applies a ready update after the user chooses to reload. */
export function requestAppUpdate(): void {
  updateRequested = true
  applyPendingUpdate()
}

/** Asks the browser to look for a new service worker. Call when the lock or login screen shows. */
export async function checkForAppUpdate(): Promise<void> {
  await registration?.update().catch(() => undefined)
}

/** Holds back updates while a login is under way, so a reload can't interrupt it. */
export async function whileLoggingIn<T>(login: () => Promise<T>): Promise<T> {
  loginsInProgress += 1
  syncSessionLock()
  try {
    return await login()
  } finally {
    loginsInProgress -= 1
    syncSessionLock()
    applyPendingUpdate()
  }
}

/**
 * Applies the new version as soon as it is ready, even mid-session. For when this build can no
 * longer work, such as when the server turns away its writes.
 */
export function forceAppUpdate(): void {
  forceUpdate = true
  applyPendingUpdate()
}
