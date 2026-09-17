import { renderHook } from '@testing-library/react'
import useSyncCoordinatorLifecycle from './useSyncCoordinatorLifecycle'
import { SyncBridge } from './SyncBridge'
import { useAppStore } from '../../state/store'

vi.mock('../../api/vault/reencrypt', () => ({
  resumePendingReencryption: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../api/vault/sessionRecovery', () => ({
  attemptSessionRecovery: vi.fn().mockResolvedValue(false),
}))

describe('useSyncCoordinatorLifecycle', () => {
  let initializeSpy: any
  let shutdownSpy: any

  beforeEach(() => {
    vi.clearAllMocks()
    initializeSpy = vi.spyOn(SyncBridge, 'initialize').mockResolvedValue(undefined)
    shutdownSpy = vi.spyOn(SyncBridge, 'shutdown').mockResolvedValue(undefined)
    useAppStore.setState({ fatalError: null, syncWarning: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not initialize if account is empty or enabled is false', () => {
    const { unmount } = renderHook(() => useSyncCoordinatorLifecycle('', false))
    expect(initializeSpy).not.toHaveBeenCalled()
    unmount()
    expect(shutdownSpy).not.toHaveBeenCalled()
  })

  it('initializes SyncBridge when account and enabled are true, and shuts down on unmount', () => {
    const { unmount } = renderHook(() => useSyncCoordinatorLifecycle('test-acc-1', true))
    expect(initializeSpy).toHaveBeenCalledWith('test-acc-1')

    unmount()
    expect(shutdownSpy).toHaveBeenCalledWith({ accountId: 'test-acc-1' })
  })

  it('skips default shutdown on unmount if SyncBridge is currently clearing local data', () => {
    vi.spyOn(SyncBridge, 'isClearingLocalData').mockReturnValue(true)

    const { unmount } = renderHook(() => useSyncCoordinatorLifecycle('test-acc-2', true))
    expect(initializeSpy).toHaveBeenCalledWith('test-acc-2')

    unmount()
    expect(shutdownSpy).not.toHaveBeenCalled()
  })

  it('resumes pending re-encryption after successful initialization', async () => {
    const { resumePendingReencryption } = await import('../../api/vault/reencrypt')
    renderHook(() => useSyncCoordinatorLifecycle('test-acc-3', true))

    await vi.waitFor(() => {
      expect(resumePendingReencryption).toHaveBeenCalledWith('test-acc-3')
    })
  })

  it('does not register a direct online window event listener', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    renderHook(() => useSyncCoordinatorLifecycle('test-acc-4', true))
    expect(addEventListenerSpy).not.toHaveBeenCalledWith('online', expect.any(Function))
  })
})
