import type { Mock } from 'vitest'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'
import * as appUpdate from './appUpdate'
import { useAppStore } from '../state/store'

describe('app updates', () => {
  let options: RegisterSWOptions
  let updateSW: Mock<(reloadPage?: boolean) => Promise<void>>
  let stopAppUpdates: () => void
  const registration = { update: vi.fn(async () => undefined) }

  function register(updateOptions?: appUpdate.AppUpdateOptions) {
    stopAppUpdates = appUpdate.registerAppUpdates(registerOptions => {
      options = registerOptions ?? {}
      return updateSW
    }, updateOptions)
    options.onRegisteredSW?.('/service-worker.js', registration as unknown as ServiceWorkerRegistration)
  }

  beforeEach(() => {
    useAppStore.setState({ loggedIn: false, appUpdateReady: false })
    registration.update.mockClear()
    updateSW = vi.fn<(reloadPage?: boolean) => Promise<void>>(async () => undefined)
    register()
  })

  afterEach(() => {
    stopAppUpdates()
    useAppStore.setState({ loggedIn: false, appUpdateReady: false })
  })

  it('signals a new version is ready and applies it once requested while nobody is logged in', () => {
    options.onNeedRefresh?.()
    expect(useAppStore.getState().appUpdateReady).toBe(true)
    expect(updateSW).not.toHaveBeenCalled()

    appUpdate.requestAppUpdate()
    expect(updateSW).toHaveBeenCalledWith(true)
    expect(useAppStore.getState().appUpdateReady).toBe(false)
  })

  it('does not apply an update until requested', () => {
    options.onNeedRefresh?.()
    expect(useAppStore.getState().appUpdateReady).toBe(true)
    expect(updateSW).not.toHaveBeenCalled()

    useAppStore.setState({ loggedIn: false })
    expect(updateSW).not.toHaveBeenCalled()
  })

  it('applies once requested while logged in', () => {
    useAppStore.setState({ loggedIn: true })

    options.onNeedRefresh?.()
    expect(updateSW).not.toHaveBeenCalled()

    appUpdate.requestAppUpdate()
    expect(updateSW).toHaveBeenCalledWith(true)
    expect(useAppStore.getState().appUpdateReady).toBe(false)
  })

  it('does not apply an unrequested update when the app locks', () => {
    useAppStore.setState({ loggedIn: true })
    options.onNeedRefresh?.()

    useAppStore.setState({ loggedIn: false })
    expect(updateSW).not.toHaveBeenCalled()
  })

  it('does not interrupt a login, and applies it afterwards if the login failed', async () => {
    let finishLogin: () => void = () => {}
    const login = appUpdate.whileLoggingIn(() => new Promise<void>((resolve, reject) => {
      finishLogin = () => reject(new Error('Incorrect password'))
    }))

    options.onNeedRefresh?.()
    expect(useAppStore.getState().appUpdateReady).toBe(true)
    appUpdate.requestAppUpdate()
    expect(updateSW).not.toHaveBeenCalled()

    finishLogin()
    await expect(login).rejects.toThrow('Incorrect password')
    expect(updateSW).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().appUpdateReady).toBe(false)
  })

  it('keeps waiting after a successful login', async () => {
    const login = appUpdate.whileLoggingIn(async () => {
      options.onNeedRefresh?.()
      appUpdate.requestAppUpdate()
      useAppStore.setState({ loggedIn: true })
    })

    await login
    expect(updateSW).not.toHaveBeenCalled()
    expect(useAppStore.getState().appUpdateReady).toBe(true)

    appUpdate.requestAppUpdate()
    expect(updateSW).toHaveBeenCalledTimes(1)
  })

  it('applies a forced update mid-session', () => {
    useAppStore.setState({ loggedIn: true })
    options.onNeedRefresh?.()

    appUpdate.forceAppUpdate()
    expect(updateSW).toHaveBeenCalledTimes(1)
  })

  it('applies a forced update once the new version is ready', () => {
    useAppStore.setState({ loggedIn: true })
    appUpdate.forceAppUpdate()
    expect(updateSW).not.toHaveBeenCalled()

    options.onNeedRefresh?.()
    expect(updateSW).toHaveBeenCalledTimes(1)
  })

  it('checks for a new version on request', async () => {
    await appUpdate.checkForAppUpdate()
    expect(registration.update).toHaveBeenCalledTimes(1)
  })

  describe('locking before the reload', () => {
    let lockBeforeReload: Mock<() => Promise<void>>

    beforeEach(() => {
      stopAppUpdates()
      lockBeforeReload = vi.fn(async () => {
        useAppStore.setState({ loggedIn: false })
      })
      register({ lockBeforeReload })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('locks a logged-in tab before reloading into the new version', async () => {
      useAppStore.setState({ loggedIn: true })
      options.onNeedRefresh?.()

      appUpdate.requestAppUpdate()
      expect(lockBeforeReload).toHaveBeenCalledTimes(1)
      expect(appUpdate.isApplyingAppUpdate()).toBe(true)
      await vi.waitFor(() => expect(updateSW).toHaveBeenCalledWith(true))
      expect(lockBeforeReload.mock.invocationCallOrder[0]).toBeLessThan(updateSW.mock.invocationCallOrder[0])
    })

    it('does not lock a tab that is already locked', () => {
      options.onNeedRefresh?.()
      appUpdate.requestAppUpdate()

      expect(lockBeforeReload).not.toHaveBeenCalled()
      expect(updateSW).toHaveBeenCalledWith(true)
    })

    it('reloads anyway if locking fails or hangs', async () => {
      vi.useFakeTimers()
      useAppStore.setState({ loggedIn: true })
      lockBeforeReload.mockImplementation(() => new Promise<void>(() => {}))
      options.onNeedRefresh?.()

      appUpdate.requestAppUpdate()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(updateSW).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(updateSW).toHaveBeenCalledWith(true)
    })
  })

  describe('checking for updates', () => {
    let visibility: DocumentVisibilityState

    beforeEach(() => {
      vi.useFakeTimers()
      visibility = 'visible'
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
      stopAppUpdates()
      register()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function becomeVisible() {
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    }

    it('checks when the app comes back after a while', () => {
      becomeVisible()
      expect(registration.update).not.toHaveBeenCalled()

      vi.setSystemTime(Date.now() + appUpdate.UPDATE_CHECK_INTERVAL_MS)
      becomeVisible()
      expect(registration.update).toHaveBeenCalledTimes(1)

      becomeVisible()
      expect(registration.update).toHaveBeenCalledTimes(1)
    })

    it('checks periodically while visible, but not while hidden', async () => {
      await vi.advanceTimersByTimeAsync(appUpdate.UPDATE_CHECK_INTERVAL_MS)
      expect(registration.update).toHaveBeenCalledTimes(1)

      visibility = 'hidden'
      await vi.advanceTimersByTimeAsync(appUpdate.UPDATE_CHECK_INTERVAL_MS)
      expect(registration.update).toHaveBeenCalledTimes(1)
    })

    it('stops checking once stopped', async () => {
      stopAppUpdates()
      await vi.advanceTimersByTimeAsync(appUpdate.UPDATE_CHECK_INTERVAL_MS)
      becomeVisible()
      expect(registration.update).not.toHaveBeenCalled()
      register()
    })
  })

  describe('applying a new version while the page is untouched', () => {
    type Worker = EventTarget & {
      state: string
      postMessage: Mock<(message: { type: string }, transfer?: MessagePort[]) => void>
    }
    let windows: number | undefined
    let swRegistration: {
      waiting: Worker | null
      installing: Worker | null
      update: Mock<() => Promise<void>>
    }
    let container: EventTarget & {
      controller: object | null
      getRegistration: () => Promise<typeof swRegistration>
    }

    function createWorker(state: string): Worker {
      return Object.assign(new EventTarget(), {
        state,
        postMessage: vi.fn((message: { type: string }, transfer?: MessagePort[]) => {
          if (message.type === 'COUNT_WINDOWS' && windows !== undefined) {
            transfer?.[0]?.postMessage({ windows })
          }
        }),
      })
    }

    function finishInstalling(worker: Worker) {
      worker.state = 'installed'
      swRegistration.installing = null
      swRegistration.waiting = worker
      worker.dispatchEvent(new Event('statechange'))
    }

    beforeEach(() => {
      windows = 1
      swRegistration = { waiting: createWorker('installed'), installing: null, update: vi.fn(async () => undefined) }
      container = Object.assign(new EventTarget(), {
        controller: {},
        getRegistration: async () => swRegistration,
      })
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
      stopAppUpdates()
    })

    afterEach(() => {
      vi.useRealTimers()
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    })

    const skipWaitingSent = (worker = swRegistration.waiting) => (
      worker?.postMessage.mock.calls.some(([message]) => message.type === 'SKIP_WAITING') ?? false
    )

    it('applies a version already waiting at startup when this is the only window', async () => {
      register()
      await vi.waitFor(() => expect(skipWaitingSent()).toBe(true))
      expect(appUpdate.isApplyingAppUpdate()).toBe(true)
      expect(swRegistration.update).not.toHaveBeenCalled()
    })

    it('applies a version that finishes installing during startup, before the startup check settles', async () => {
      const installing = createWorker('installing')
      swRegistration.waiting = null
      swRegistration.update.mockImplementation(async () => {
        swRegistration.installing = installing
      })
      let settled = false
      register()
      void appUpdate.whenStartupUpdateChecked().then(() => { settled = true })

      await vi.waitFor(() => expect(swRegistration.update).toHaveBeenCalledTimes(1))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(settled).toBe(false)

      finishInstalling(installing)
      await vi.waitFor(() => expect(settled).toBe(true))
      expect(skipWaitingSent(installing)).toBe(true)
      expect(appUpdate.isApplyingAppUpdate()).toBe(true)
    })

    it('stops holding up the startup check when installing takes too long', async () => {
      vi.useFakeTimers()
      swRegistration.waiting = null
      swRegistration.update.mockImplementation(async () => {
        swRegistration.installing = createWorker('installing')
      })
      let settled = false
      register()
      void appUpdate.whenStartupUpdateChecked().then(() => { settled = true })

      await vi.advanceTimersByTimeAsync(appUpdate.STARTUP_UPDATE_WAIT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(appUpdate.isApplyingAppUpdate()).toBe(false)
    })

    it('applies a version found later while the page is still untouched', async () => {
      swRegistration.waiting = null
      register()
      await appUpdate.whenStartupUpdateChecked()

      swRegistration.waiting = createWorker('installed')
      options.onNeedRefresh?.()
      await vi.waitFor(() => expect(skipWaitingSent()).toBe(true))
    })

    it('leaves a version found later to the prompt once the user has used the page', async () => {
      swRegistration.waiting = null
      register()
      await appUpdate.whenStartupUpdateChecked()

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
      swRegistration.waiting = createWorker('installed')
      options.onNeedRefresh?.()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(swRegistration.waiting.postMessage).not.toHaveBeenCalled()
      expect(useAppStore.getState().appUpdateReady).toBe(true)
    })

    it('leaves it to the prompt while logged in', async () => {
      useAppStore.setState({ loggedIn: true })
      register()
      await appUpdate.whenStartupUpdateChecked()
      expect(skipWaitingSent()).toBe(false)
    })

    it('leaves it to the prompt when other windows are open', async () => {
      windows = 2
      register()
      await appUpdate.whenStartupUpdateChecked()
      expect(swRegistration.waiting?.postMessage).toHaveBeenCalledTimes(1)
      expect(skipWaitingSent()).toBe(false)
    })

    it('leaves it to the prompt when the waiting version can not count windows', async () => {
      vi.useFakeTimers()
      windows = undefined
      register()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(skipWaitingSent()).toBe(false)
    })

    it('leaves it alone once a login has started, even one that was cancelled', async () => {
      let finishLogin: () => void = () => {}
      register()
      const login = appUpdate.whileLoggingIn(() => new Promise<void>((resolve, reject) => {
        finishLogin = () => reject(new Error('Cancelled'))
      }))
      await appUpdate.whenStartupUpdateChecked()
      expect(skipWaitingSent()).toBe(false)

      finishLogin()
      await expect(login).rejects.toThrow('Cancelled')
      options.onNeedRefresh?.()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(skipWaitingSent()).toBe(false)
    })

    it('does nothing on a page no service worker controls', async () => {
      container.controller = null
      register()
      await appUpdate.whenStartupUpdateChecked()
      expect(swRegistration.waiting?.postMessage).not.toHaveBeenCalled()
      expect(swRegistration.update).not.toHaveBeenCalled()
    })
  })
})
