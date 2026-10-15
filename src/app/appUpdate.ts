import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { useAppStore } from '../state/store'

type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

/*
 * Applying a new build reloads the page, which forgets the vault keys and locks the app. So a new
 * service worker only takes over while nobody is logged in: on the lock or login screen, or once
 * the app locks. A logged-in session therefore keeps running the build it started with, whose
 * lazily loaded chunks are still in the old service worker's precache.
 */

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null
let registration: ServiceWorkerRegistration | undefined
let updatePending = false
let forceUpdate = false
let loginsInProgress = 0

function canApplyUpdate(): boolean {
  return forceUpdate || (!useAppStore.getState().loggedIn && loginsInProgress === 0)
}

function applyPendingUpdate(): void {
  if (!updatePending || !updateServiceWorker || !canApplyUpdate()) return
  updatePending = false
  console.info('[PWA] Applying the new version of the app')
  void updateServiceWorker(true)
}

/** Registers the service worker. Call once at startup with `registerSW` from `virtual:pwa-register`. */
export function registerAppUpdates(registerSW: RegisterSW): void {
  updateServiceWorker = registerSW({
    onNeedRefresh() {
      console.info('[PWA] A new version of the app is ready')
      updatePending = true
      applyPendingUpdate()
    },
    onOfflineReady() {
      console.info('[PWA] App is ready to work offline.')
    },
    onRegisteredSW(_url, swRegistration) {
      registration = swRegistration
    },
  })

  useAppStore.subscribe((state, previous) => {
    if (previous.loggedIn && !state.loggedIn) {
      applyPendingUpdate()
    }
  })
}

/** Asks the browser to look for a new service worker. Call when the lock or login screen shows. */
export async function checkForAppUpdate(): Promise<void> {
  await registration?.update().catch(() => undefined)
}

/** Holds back updates while a login is under way, so a reload can't interrupt it. */
export async function whileLoggingIn<T>(login: () => Promise<T>): Promise<T> {
  loginsInProgress += 1
  try {
    return await login()
  } finally {
    loginsInProgress -= 1
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

