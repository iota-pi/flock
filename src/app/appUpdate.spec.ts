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

  it('applies a new version straight away while nobody is logged in', () => {
    options.onNeedRefresh?.()
    expect(updateSW).toHaveBeenCalledWith(true)
  })

  it('waits until the app locks when someone is logged in', () => {
    useAppStore.setState({ loggedIn: true })

    options.onNeedRefresh?.()
    expect(updateSW).not.toHaveBeenCalled()

    useAppStore.setState({ loggedIn: false })
    expect(updateSW).toHaveBeenCalledTimes(1)
  })

  it('does not interrupt a login, and applies it afterwards if the login failed', async () => {
    let finishLogin: () => void = () => {}
    const login = appUpdate.whileLoggingIn(() => new Promise<void>((resolve, reject) => {
      finishLogin = () => reject(new Error('Incorrect password'))
    }))

    options.onNeedRefresh?.()
    expect(updateSW).not.toHaveBeenCalled()

    finishLogin()
    await expect(login).rejects.toThrow('Incorrect password')
    expect(updateSW).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting after a successful login', async () => {
    const login = appUpdate.whileLoggingIn(async () => {
      options.onNeedRefresh?.()
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
})
