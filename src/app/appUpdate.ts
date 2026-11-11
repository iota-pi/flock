import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import { useAppStore } from '../state/store'
import { createLogger } from 'src/utils/logger'

const log = createLogger('appUpdate')

type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>

export type AppUpdateOptions = {
  /** Locks the vault cleanly (stopping sync) before a logged-in tab reloads into the new version */
  lockBeforeReload?: () => Promise<void>
}

/*
 * Applying a new build reloads the page, which forgets the vault keys and locks the app. So a new
 * service worker only takes over when the user chooses to reload (the update snackbar), when this
 * build can no longer work (forceAppUpdate), or while the page is untouched and is the only Flock
 * window, so the reload costs nothing. A page is untouched when it has just loaded, and again when the
 * vault locks (by hand, or automatically), until the user does something on the lock screen. Until
 * then a session keeps running the build it started with, whose lazily loaded chunks are still in the
 * old service worker's precache.
 *
 * The new service worker takes over every tab at once, and each tab reloads (and locks) when it does.
 * The browser itself never swaps service workers on a reload while a page it controls stays open.
 *
 * A launch usually finds a new version partway through loading, after the page has checked for one
 * waiting. So at startup, and when the vault locks, the page also looks for a new version itself and
 * waits (briefly) for it to install, and the login page holds its biometric prompt until then, so one
 * launch (or lock) is enough to update.
 */

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
const LOCK_TIMEOUT_MS = 5_000
const WINDOW_COUNT_TIMEOUT_MS = 1_000
/** How long the login page holds its biometric prompt for the check that follows a launch or lock */
export const UNTOUCHED_UPDATE_WAIT_MS = 5_000

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null
let registration: ServiceWorkerRegistration | undefined
let lockBeforeReload: (() => Promise<void>) | undefined
let updatePending = false
let updateRequested = false
let forceUpdate = false
let applying = false
let loginsInProgress = 0
let lastUpdateCheck = 0
// Whether the user has done anything on this page since it loaded or locked, after which a reload
// would lose their work
let pageTouched = false
let updateCheckSettled: Promise<void> = Promise.resolve()
// Bumped when updates stop being watched, so async work started before then gives up
let generation = 0

async function lockThenUpdate(update: (reloadPage?: boolean) => Promise<void>): Promise<void> {
  if (useAppStore.getState().loggedIn && lockBeforeReload) {
    // A stuck shutdown mustn't block the update: the reload ends the session anyway
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      lockBeforeReload().catch(error => log.error('Failed to lock before updating', error)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, LOCK_TIMEOUT_MS) }),
    ])
    clearTimeout(timer)
  }
  await update(true)
}

function applyPendingUpdate(): void {
  if (!updatePending || !updateServiceWorker || applying) return
  // A reload in the middle of a login could interrupt it, so a requested update waits for it to finish
  if (!forceUpdate && !(updateRequested && loginsInProgress === 0)) return

  applying = true
  updatePending = false
  updateRequested = false
  useAppStore.getState().setAppUpdateReady(false)
  void lockThenUpdate(updateServiceWorker).finally(() => {
    applying = false
  })
}

/** Asks the waiting service worker how many Flock windows are open. Builds before it don't answer. */
function countOpenWindows(worker: ServiceWorker): Promise<number | undefined> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(undefined), WINDOW_COUNT_TIMEOUT_MS)
    channel.port1.onmessage = (event: MessageEvent<{ windows?: unknown }>) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(typeof event.data?.windows === 'number' ? event.data.windows : undefined)
    }
    worker.postMessage({ type: 'COUNT_WINDOWS' }, [channel.port2])
  })
}

function markPageTouched(): void {
  pageTouched = true
}

/** Resolves once `worker` has finished installing (or failed to), or after `ms` */
function waitForInstall(worker: ServiceWorker | null, ms: number): Promise<void> {
  if (!worker || worker.state !== 'installing') return Promise.resolve()
  const controller = new AbortController()
  return new Promise<void>(resolve => {
    controller.signal.addEventListener('abort', () => resolve())
    const timer = setTimeout(() => controller.abort(), ms)
    controller.signal.addEventListener('abort', () => clearTimeout(timer))
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installing') controller.abort()
    }, { signal: controller.signal })
  })
}

/**
 * Applies the waiting version straight away while this page is untouched and the only Flock window.
 * The page has only just loaded, so it's locked and nothing is lost by reloading it.
 */
async function applyWaitingUpdateIfUntouched(): Promise<void> {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  // An uncontrolled page (the first visit, or a hard reload) has nothing waiting to take over from
  if (!container?.controller) return
  const startedIn = generation
  const isUntouched = () => (
    startedIn === generation && !pageTouched && !applying && !useAppStore.getState().loggedIn && loginsInProgress === 0
  )
  if (!isUntouched()) return

  const waiting = (await container.getRegistration())?.waiting
  if (!waiting) return
  // Taking over would reload the other windows too, which nobody asked for
  if (await countOpenWindows(waiting) !== 1) return
  if (!isUntouched()) return

  log.info('Applying the new version while the page is untouched')
  applying = true
  updatePending = false
  useAppStore.getState().setAppUpdateReady(false)
  container.addEventListener('controllerchange', () => window.location.reload(), { once: true })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

/**
 * Looks for a new version (at startup, or when the vault locks) and waits for it to install, so it
 * can be applied before the user starts using this page rather than at the next launch.
 */
async function checkAndApplyWhileUntouched(): Promise<void> {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (!container?.controller) return
  const swRegistration = await container.getRegistration()
  if (!swRegistration) return
  if (!swRegistration.waiting) {
    const deadline = Date.now() + UNTOUCHED_UPDATE_WAIT_MS
    lastUpdateCheck = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      swRegistration.update().catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, UNTOUCHED_UPDATE_WAIT_MS) }),
    ])
    clearTimeout(timer)
    await waitForInstall(swRegistration.installing, Math.max(0, deadline - Date.now()))
  }
  await applyWaitingUpdateIfUntouched()
}

function startUntouchedUpdateCheck(): void {
  updateCheckSettled = checkAndApplyWhileUntouched().catch(error => log.error('Failed to check for a new version', error))
}

/**
 * Resolves once the check for a new version that follows a launch or lock has finished (or given up
 * waiting), for the login page to hold its biometric prompt until then. Check `isApplyingAppUpdate`
 * afterwards.
 */
export function whenUpdateCheckSettled(): Promise<void> {
  return updateCheckSettled
}

/**
 * The lock screen has nothing to lose until the user starts unlocking, so a locked page counts as
 * untouched again. Runs as the store changes, before the login page renders and waits on the check.
 */
function handleLoggedInChange(loggedIn: boolean, wasLoggedIn: boolean): void {
  if (!wasLoggedIn || loggedIn || applying) return
  pageTouched = false
  startUntouchedUpdateCheck()
}

function checkForAppUpdateWhenOnline(): void {
  if (document.visibilityState === 'visible') {
    void checkForAppUpdate()
  }
}

function checkForAppUpdateIfDue(): void {
  if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck >= UPDATE_CHECK_INTERVAL_MS) {
    void checkForAppUpdate()
  }
}

/**
 * Registers the service worker. Call once at startup with `registerSW` from `virtual:pwa-register`.
 * Returns a function that stops watching for updates and forgets any that are pending.
 */
export function registerAppUpdates(registerSW: RegisterSW, options: AppUpdateOptions = {}): () => void {
  lockBeforeReload = options.lockBeforeReload
  // The browser checks when the page loads, so a long-lived session is the one that needs checking
  lastUpdateCheck = Date.now()
  updateServiceWorker = registerSW({
    onNeedRefresh() {
      updatePending = true
      useAppStore.getState().setAppUpdateReady(true)
      applyPendingUpdate()
      void applyWaitingUpdateIfUntouched().catch(error => log.error('Failed to apply the new version', error))
    },
    onOfflineReady() {
      log.info('App is ready to work offline.')
    },
    onRegisteredSW(_url, swRegistration) {
      registration = swRegistration
    },
  })

  pageTouched = false
  window.addEventListener('pointerdown', markPageTouched, { capture: true })
  window.addEventListener('keydown', markPageTouched, { capture: true })
  startUntouchedUpdateCheck()
  const unsubscribeStore = useAppStore.subscribe((state, previous) => {
    handleLoggedInChange(state.loggedIn, previous.loggedIn)
  })

  // An installed app can stay open (or suspended in the background) for days without a page load
  document.addEventListener('visibilitychange', checkForAppUpdateIfDue)
  // A check that came due while offline would otherwise wait for the next interval
  window.addEventListener('online', checkForAppUpdateWhenOnline)
  const interval = setInterval(checkForAppUpdateIfDue, UPDATE_CHECK_INTERVAL_MS)

  return () => {
    unsubscribeStore()
    document.removeEventListener('visibilitychange', checkForAppUpdateIfDue)
    window.removeEventListener('online', checkForAppUpdateWhenOnline)
    window.removeEventListener('pointerdown', markPageTouched, { capture: true })
    window.removeEventListener('keydown', markPageTouched, { capture: true })
    clearInterval(interval)
    generation += 1
    updateServiceWorker = null
    registration = undefined
    lockBeforeReload = undefined
    updatePending = false
    updateRequested = false
    forceUpdate = false
    applying = false
    updateCheckSettled = Promise.resolve()
  }
}

/**
 * Applies a ready update now that the user has chosen to update. Every open tab reloads with it, which
 * locks any that are logged in.
 */
export function requestAppUpdate(): void {
  updateRequested = true
  applyPendingUpdate()
}

/** Whether this tab is reloading into a new version, so the login page shouldn't prompt for biometrics */
export function isApplyingAppUpdate(): boolean {
  return applying
}

/** Asks the browser to look for a new service worker, such as when the lock or login screen shows. */
export async function checkForAppUpdate(): Promise<void> {
  lastUpdateCheck = Date.now()
  await registration?.update().catch(() => undefined)
}

/** Holds back updates while a login is under way, so a reload can't interrupt it. */
export async function whileLoggingIn<T>(login: () => Promise<T>): Promise<T> {
  // Even a cancelled login (say, a biometric prompt) means the user is using this page
  pageTouched = true
  loginsInProgress += 1
  try {
    return await login()
  } finally {
    loginsInProgress -= 1
    if (useAppStore.getState().loggedIn) {
      // Don't lock the user out straight after they logged in. The snackbar stays up to ask again.
      updateRequested = false
    } else {
      applyPendingUpdate()
    }
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
