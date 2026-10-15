import { CLIENT_OUTDATED_WARNING, handleClientOutdated } from './clientOutdated'

describe('handleClientOutdated', () => {
  const reload = vi.fn()
  const applyUpdate = vi.fn()
  let registration: { update: ReturnType<typeof vi.fn>, installing: unknown, waiting: unknown }

  beforeEach(() => {
    sessionStorage.clear()
    reload.mockReset()
    applyUpdate.mockReset()
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

  it('applies the new version when one is installing, instead of reloading', async () => {
    registration.update.mockImplementation(async () => {
      registration.installing = {}
    })
    const showWarning = vi.fn()

    await handleClientOutdated({ showWarning, applyUpdate })

    expect(registration.update).toHaveBeenCalled()
    expect(applyUpdate).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(showWarning).not.toHaveBeenCalled()
  })

  it('reloads when no new version turns up', async () => {
    await handleClientOutdated({ showWarning: vi.fn(), applyUpdate })

    expect(reload).toHaveBeenCalledTimes(1)
    expect(applyUpdate).not.toHaveBeenCalled()
  })

  it('asks the user to reload rather than reloading again within a few minutes', async () => {
    const showWarning = vi.fn()
    let now = 1_000_000

    await handleClientOutdated({ now: () => now, showWarning, applyUpdate })
    now += 60_000
    await handleClientOutdated({ now: () => now, showWarning, applyUpdate })

    expect(reload).toHaveBeenCalledTimes(1)
    expect(showWarning).toHaveBeenCalledWith(CLIENT_OUTDATED_WARNING)

    now += 10 * 60_000
    await handleClientOutdated({ now: () => now, showWarning, applyUpdate })
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
