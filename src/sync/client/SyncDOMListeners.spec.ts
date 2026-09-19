import { SyncDOMListeners, type SyncDOMListenersCallbacks } from './SyncDOMListeners'
import { KEYRING_CACHE_KEY, VAULT_EVENTS_CHANNEL } from 'src/api/vault'
import { useAppStore } from 'src/state/store'

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
    useAppStore.setState({ syncWarning: null })
  })

  afterEach(() => {
    listeners.stop()
    vi.restoreAllMocks()
  })

  it('handles online and offline events', async () => {
    listeners.start(callbacks)

    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    await vi.waitFor(() => {
      expect(callbacks.onOnlineChange).toHaveBeenCalledWith(false)
    })

    onLineSpy.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => {
      expect(callbacks.onOnlineChange).toHaveBeenCalledWith(true)
    })
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

  describe('online pipeline sequencing', () => {
    it('executes in strict order: setOnlineState -> attemptSessionRecovery -> flushSync -> resumePendingReencryption', async () => {
      const callOrder: string[] = []
      let resolveSetOnlineState!: () => void
      const setOnlineStatePromise = new Promise<void>(resolve => {
        resolveSetOnlineState = resolve
      })

      const setOnlineState = vi.fn().mockImplementation(async (isOnline: boolean) => {
        callOrder.push(`setOnlineState:${isOnline}`)
        if (isOnline) {
          await setOnlineStatePromise
        }
      })

      const attemptSessionRecovery = vi.fn().mockImplementation(async (account: string) => {
        callOrder.push(`attemptSessionRecovery:${account}`)
        return true
      })

      const flushSync = vi.fn().mockImplementation(async () => {
        callOrder.push('flushSync')
      })

      const resumePendingReencryption = vi.fn().mockImplementation(async (account: string) => {
        callOrder.push(`resumePendingReencryption:${account}`)
      })

      useAppStore.setState({ syncWarning: 'Warning before reconnect' })

      listeners.start({
        setOnlineState,
        getAccountId: () => 'acc-123',
        attemptSessionRecovery,
        flushSync,
        resumePendingReencryption,
        onVisibilityHidden: vi.fn(),
        onKeyringChange: vi.fn(),
      })

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      window.dispatchEvent(new Event('online'))

      // setOnlineState has been initiated, but has not resolved yet
      await vi.waitFor(() => {
        expect(setOnlineState).toHaveBeenCalledWith(true)
      })
      expect(callOrder).toEqual(['setOnlineState:true'])
      expect(attemptSessionRecovery).not.toHaveBeenCalled()
      expect(flushSync).not.toHaveBeenCalled()

      // Resolve setOnlineState
      resolveSetOnlineState()

      await vi.waitFor(() => {
        expect(flushSync).toHaveBeenCalledTimes(1)
      })

      expect(callOrder).toEqual([
        'setOnlineState:true',
        'attemptSessionRecovery:acc-123',
        'flushSync',
        'resumePendingReencryption:acc-123',
      ])
      expect(useAppStore.getState().syncWarning).toBeNull()
    })

    it('does not flush or clear warning if session recovery returns false', async () => {
      const setOnlineState = vi.fn().mockResolvedValue(undefined)
      const attemptSessionRecovery = vi.fn().mockResolvedValue(false)
      const flushSync = vi.fn().mockResolvedValue(undefined)
      const resumePendingReencryption = vi.fn().mockResolvedValue(undefined)

      useAppStore.setState({ syncWarning: 'Persistent sync warning' })

      listeners.start({
        setOnlineState,
        getAccountId: () => 'acc-unrecovered',
        attemptSessionRecovery,
        flushSync,
        resumePendingReencryption,
        onVisibilityHidden: vi.fn(),
        onKeyringChange: vi.fn(),
      })

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      window.dispatchEvent(new Event('online'))

      await vi.waitFor(() => {
        expect(attemptSessionRecovery).toHaveBeenCalledWith('acc-unrecovered')
      })

      expect(flushSync).not.toHaveBeenCalled()
      expect(useAppStore.getState().syncWarning).toBe('Persistent sync warning')
      expect(resumePendingReencryption).toHaveBeenCalledWith('acc-unrecovered')
    })

    it('does not attempt session recovery or flush on offline event', async () => {
      const setOnlineState = vi.fn().mockResolvedValue(undefined)
      const attemptSessionRecovery = vi.fn().mockResolvedValue(true)
      const flushSync = vi.fn().mockResolvedValue(undefined)

      listeners.start({
        setOnlineState,
        getAccountId: () => 'acc-123',
        attemptSessionRecovery,
        flushSync,
        onVisibilityHidden: vi.fn(),
        onKeyringChange: vi.fn(),
      })

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      window.dispatchEvent(new Event('offline'))

      await vi.waitFor(() => {
        expect(setOnlineState).toHaveBeenCalledWith(false)
      })

      expect(attemptSessionRecovery).not.toHaveBeenCalled()
      expect(flushSync).not.toHaveBeenCalled()
    })

    it('skips session recovery if no account id is available', async () => {
      const setOnlineState = vi.fn().mockResolvedValue(undefined)
      const attemptSessionRecovery = vi.fn().mockResolvedValue(true)
      const flushSync = vi.fn().mockResolvedValue(undefined)

      listeners.start({
        setOnlineState,
        getAccountId: () => null,
        attemptSessionRecovery,
        flushSync,
        onVisibilityHidden: vi.fn(),
        onKeyringChange: vi.fn(),
      })

      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      window.dispatchEvent(new Event('online'))

      await vi.waitFor(() => {
        expect(setOnlineState).toHaveBeenCalledWith(true)
      })

      expect(attemptSessionRecovery).not.toHaveBeenCalled()
      expect(flushSync).not.toHaveBeenCalled()
    })
  })
})
