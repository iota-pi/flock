import { SyncDOMListeners, type SyncDOMListenersCallbacks } from './SyncDOMListeners'
import { KEYRING_CACHE_KEY, VAULT_EVENTS_CHANNEL } from 'src/api/vault'

describe('SyncDOMListeners', () => {
  let listeners: SyncDOMListeners
  let callbacks: SyncDOMListenersCallbacks
  let onOnlineChange: ReturnType<typeof vi.fn<(isOnline: boolean) => void>>
  let onVisibilityHidden: ReturnType<typeof vi.fn<() => void>>
  let onKeyringChange: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    listeners = new SyncDOMListeners()
    onOnlineChange = vi.fn<(isOnline: boolean) => void>()
    onVisibilityHidden = vi.fn<() => void>()
    onKeyringChange = vi.fn<() => void>()
    callbacks = {
      onOnlineChange,
      onVisibilityHidden,
      onKeyringChange,
    }
  })

  afterEach(() => {
    listeners.stop()
    vi.restoreAllMocks()
  })

  it('handles online and offline events', () => {
    listeners.start(callbacks)

    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    expect(callbacks.onOnlineChange).toHaveBeenCalledWith(false)

    onLineSpy.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    expect(callbacks.onOnlineChange).toHaveBeenCalledWith(true)
  })

  it('handles visibility change to hidden', () => {
    listeners.start(callbacks)

    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(callbacks.onVisibilityHidden).not.toHaveBeenCalled()

    visibilitySpy.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(callbacks.onVisibilityHidden).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('pagehide'))
    expect(callbacks.onVisibilityHidden).toHaveBeenCalledTimes(2)
  })

  it('handles storage events matching KEYRING_CACHE_KEY', () => {
    listeners.start(callbacks)

    window.dispatchEvent(new StorageEvent('storage', { key: 'OTHER_KEY' }))
    expect(callbacks.onKeyringChange).not.toHaveBeenCalled()

    window.dispatchEvent(new StorageEvent('storage', { key: KEYRING_CACHE_KEY }))
    expect(callbacks.onKeyringChange).toHaveBeenCalledTimes(1)
  })

  it('handles BroadcastChannel vault events', async () => {
    listeners.start(callbacks)

    const channel = new BroadcastChannel(VAULT_EVENTS_CHANNEL)
    channel.postMessage({ type: 'OTHER_EVENT' })
    expect(callbacks.onKeyringChange).not.toHaveBeenCalled()

    channel.postMessage({ type: 'KEY_ROTATED' })
    await vi.waitFor(() => {
      expect(callbacks.onKeyringChange).toHaveBeenCalledTimes(1)
    })

    channel.postMessage({ type: 'PASSWORD_CHANGED' })
    await vi.waitFor(() => {
      expect(callbacks.onKeyringChange).toHaveBeenCalledTimes(2)
    })

    channel.close()
  })

  it('removes all event listeners and closes BroadcastChannel on stop', () => {
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener')

    listeners.start(callbacks)
    listeners.stop()

    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('offline', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('pagehide', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('storage', expect.any(Function))
    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    // Dispatched events after stop should not trigger callbacks
    window.dispatchEvent(new Event('online'))
    expect(callbacks.onOnlineChange).not.toHaveBeenCalled()
  })
})
