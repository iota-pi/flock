import { CLIENT_OUTDATED_WARNING, handleClientOutdated } from './clientOutdated'

describe('handleClientOutdated', () => {
  const reload = vi.fn()
  let registration: { update: ReturnType<typeof vi.fn>, installing: unknown, waiting: unknown }

  beforeEach(() => {
    sessionStorage.clear()
    reload.mockReset()
    registration = { update: vi.fn(async () => undefined), installing: null, waiting: null }
    vi.stubGlobal('location', { ...window.location, reload })
    vi.stubGlobal('navigator', {
      ...navigator,
      serviceWorker: { getRegistration: vi.fn(async () => registration) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves the reload to the service worker when a new version is installing', async () => {
    registration.update.mockImplementation(async () => {
      registration.installing = {}
    })
    const showWarning = vi.fn()

    await handleClientOutdated({ showWarning })

    expect(registration.update).toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(showWarning).not.toHaveBeenCalled()
  })

  it('reloads when no new version turns up', async () => {
    await handleClientOutdated({ showWarning: vi.fn() })

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks the user to reload rather than reloading again within a few minutes', async () => {
    const showWarning = vi.fn()
    let now = 1_000_000

    await handleClientOutdated({ now: () => now, showWarning })
    now += 60_000
    await handleClientOutdated({ now: () => now, showWarning })

    expect(reload).toHaveBeenCalledTimes(1)
    expect(showWarning).toHaveBeenCalledWith(CLIENT_OUTDATED_WARNING)

    now += 10 * 60_000
    await handleClientOutdated({ now: () => now, showWarning })
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
