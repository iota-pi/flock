import type { Mock } from 'vitest'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

type AppUpdateModule = typeof import('./appUpdate')
type AppStore = typeof import('../state/store')['useAppStore']

describe('app updates', () => {
  let appUpdate: AppUpdateModule
  let options: RegisterSWOptions
  let updateSW: Mock<(reloadPage?: boolean) => Promise<void>>
  // Imported after resetting modules, so it is the same store appUpdate sees
  let useAppStore: AppStore
  const registration = { update: vi.fn(async () => undefined) }

  beforeEach(async () => {
    vi.resetModules()
    useAppStore = (await import('../state/store')).useAppStore
    useAppStore.setState({ loggedIn: false })
    registration.update.mockClear()
    updateSW = vi.fn<(reloadPage?: boolean) => Promise<void>>(async () => undefined)
    appUpdate = await import('./appUpdate')
    appUpdate.registerAppUpdates(registerOptions => {
      options = registerOptions ?? {}
      return updateSW
    })
    options.onRegisteredSW?.('/service-worker.js', registration as unknown as ServiceWorkerRegistration)
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

  it('waits until the app locks when someone is logged in', () => {
    useAppStore.setState({ loggedIn: true })

    options.onNeedRefresh?.()
    expect(useAppStore.getState().appUpdateReady).toBe(true)
    appUpdate.requestAppUpdate()
    expect(updateSW).not.toHaveBeenCalled()

    useAppStore.setState({ loggedIn: false })
    expect(updateSW).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().appUpdateReady).toBe(false)
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

  describe('with other tabs', () => {
    let sharedHolders: number
    let releaseOtherTab: () => void

    function holdLockInOtherTab() {
      void navigator.locks.request(appUpdate.SESSION_LOCK, { mode: 'shared' }, () => new Promise<void>(resolve => {
        releaseOtherTab = resolve
      }))
    }

    beforeEach(() => {
      sharedHolders = 0
      const locks = {
        request: async (
          _name: string,
          options: LockOptions,
          callback: (lock: Lock | null) => Promise<unknown> | unknown,
        ) => {
          if (options.mode === 'shared') {
            sharedHolders += 1
            try {
              return await callback({} as Lock)
            } finally {
              sharedHolders -= 1
            }
          }
          return callback(sharedHolders > 0 ? null : {} as Lock)
        },
      }
      Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
    })

    afterEach(() => {
      delete (navigator as { locks?: unknown }).locks
      vi.useRealTimers()
    })

    it('holds the session lock while logged in', async () => {
      useAppStore.setState({ loggedIn: true })
      await vi.waitFor(() => expect(sharedHolders).toBe(1))

      useAppStore.setState({ loggedIn: false })
      await vi.waitFor(() => expect(sharedHolders).toBe(0))
    })

    it('waits for another tab that is logged in', async () => {
      vi.useFakeTimers()
      holdLockInOtherTab()

      options.onNeedRefresh?.()
      expect(useAppStore.getState().appUpdateReady).toBe(true)
      appUpdate.requestAppUpdate()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(updateSW).not.toHaveBeenCalled()

      releaseOtherTab()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(updateSW).toHaveBeenCalledTimes(1)
      expect(useAppStore.getState().appUpdateReady).toBe(false)
    })

    it('applies once requested when no tab is logged in', async () => {
      options.onNeedRefresh?.()
      expect(useAppStore.getState().appUpdateReady).toBe(true)
      appUpdate.requestAppUpdate()
      await vi.waitFor(() => expect(updateSW).toHaveBeenCalledWith(true))
      expect(useAppStore.getState().appUpdateReady).toBe(false)
    })

    it('applies a forced update even while another tab is logged in', () => {
      holdLockInOtherTab()
      options.onNeedRefresh?.()

      appUpdate.forceAppUpdate()
      expect(updateSW).toHaveBeenCalledTimes(1)
    })
  })
})
