import { act, renderHook } from '@testing-library/react'

import useSettings from './useSettings'
import type { Item } from 'src/state/items'
import type { BackupSyncState } from 'src/types/backup'
import { ItemId } from 'src/shared/schemas/items'


const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  lockVault: vi.fn(),
  removeVaultFromDevice: vi.fn(),
  storeItems: vi.fn(),
  setMetadata: vi.fn(),

  exportAllBinaries: vi.fn(() => ({
    documents: { i1: 'base64-doc' },
    skipped: [] as string[],
  })),
  restoreFromBinaries: vi.fn(async () => ['i1']),
  clearAutomergeDocStore: vi.fn(async () => undefined),
  exportSyncState: vi.fn(async () => (
    { cursors: [], pendingSync: [], lastModified: [] } as BackupSyncState
  )),
  restoreSyncState: vi.fn(async () => undefined),
  forceSync: vi.fn(async () => undefined),
  fullResync: vi.fn(async () => undefined),
  setMessage: vi.fn(),
  setUi: vi.fn(),
}))

vi.mock('../api/vault', () => ({
  exportData: mocks.exportData,
  lockVault: mocks.lockVault,
  removeVaultFromDevice: mocks.removeVaultFromDevice,
  hasBiometricData: vi.fn(() => false),
  isWebAuthnPrfSupported: vi.fn(async () => true),
  enableBiometrics: vi.fn(async () => undefined),
  disableBiometrics: vi.fn(async () => undefined),
}))

vi.mock('../features/items/mutations/itemMutations', () => ({
  storeItems: mocks.storeItems,
  setMetadata: mocks.setMetadata,
}))

vi.mock('../state/selectors', () => ({
  useMetadata: (_key: string, defaultValue?: unknown) => [defaultValue, vi.fn()],
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({ account: 'acct-1', loggedIn: true, initializing: false }),
}))

const mockStore = {
  account: 'acct-1',
  darkMode: null,
  setMessage: mocks.setMessage,
  setUi: mocks.setUi,
}

vi.mock('../state/store', () => ({
  useAppStore: Object.assign(
    (selector: any) => selector(mockStore),
    {
      getState: () => mockStore,
      setState: vi.fn(),
    }
  )
}))


vi.mock('../sync/client/SyncBridge', () => ({
  SyncBridge: {
    clearAutomergeDocStore: mocks.clearAutomergeDocStore,
    exportAllBinaries: mocks.exportAllBinaries,
    restoreFromBinaries: mocks.restoreFromBinaries,
    exportSyncState: mocks.exportSyncState,
    restoreSyncState: mocks.restoreSyncState,
    forceSync: mocks.forceSync,
    fullResync: mocks.fullResync,
    listRecoveryItems: vi.fn(async () => []),
    subscribeRecoveryItems: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => {}),
  }
}))

describe('useSettings backup portability', () => {
  const mockItems = [{ id: 'i1', type: 'person', name: 'N', archived: false } as Item]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports metadata and items in a v2 payload along with sync state', async () => {
    mocks.exportData.mockImplementation(async (payload: unknown) => payload)
    mocks.exportSyncState.mockResolvedValue({
      cursors: [['i1' as ItemId, 10]],
      pendingSync: [['i1' as ItemId, ['msg1']]],
      lastModified: [['i1' as ItemId, 12345]]
    })

    const { result } = renderHook(() => useSettings(mockItems))

    let json = ''
    await act(async () => {
      json = await result.current.actions.handleExport()
    })

    const parsed = JSON.parse(json)
    expect(parsed).toMatchObject({
      version: 2,
      documents: { i1: 'base64-doc' },
      cursors: [['i1', 10]],
      pendingSync: [['i1', ['msg1']]],
      lastModified: [['i1', 12345]]
    })
    expect(mocks.exportSyncState).toHaveBeenCalledTimes(1)
  })

  it('warns the user when items were skipped during export', async () => {
    mocks.exportData.mockImplementation(async (payload: unknown) => payload)
    mocks.exportAllBinaries.mockResolvedValueOnce({
      documents: { i1: 'base64-doc' },
      skipped: ['i2'],
    })

    const { result } = renderHook(() => useSettings(mockItems))

    await act(async () => {
      await result.current.actions.handleExport()
    })

    expect(mocks.setMessage).toHaveBeenCalledWith({
      message: 'Backup created, but 1 item could not be loaded.',
      severity: 'warning',
    })
  })

  it('restores metadata, binaries, and sync state without queue side effects', async () => {
    mocks.restoreFromBinaries.mockResolvedValue(['i1'])
    mocks.setMetadata.mockResolvedValue(undefined)

    const { result } = renderHook(() => useSettings(mockItems))

    await act(async () => {
      await result.current.actions.handleConfirmRestore({
        version: 2,
        metadata: {},
        documents: { ['i1' as ItemId]: 'base64-doc' },
        cursors: [['i1' as ItemId, 10]],
        pendingSync: [['i1' as ItemId, ['msg1']]],
        lastModified: [['i1' as ItemId, 12345]]
      })
    })

    expect(mocks.setMetadata).toHaveBeenCalledTimes(1)
    expect(mocks.restoreFromBinaries).toHaveBeenCalledTimes(1)
    expect(mocks.restoreSyncState).toHaveBeenCalledWith({
      cursors: [['i1', 10]],
      pendingSync: [['i1', ['msg1']]],
      lastModified: [['i1', 12345]]
    })
    expect(mocks.forceSync).toHaveBeenCalledTimes(1)
    expect(mocks.storeItems).not.toHaveBeenCalled()
  })

  it('handles lock action', async () => {
    const { result } = renderHook(() => useSettings(mockItems))

    await act(async () => {
      await result.current.actions.handleLock()
    })

    expect(mocks.lockVault).toHaveBeenCalledTimes(1)
    expect(mocks.setMessage).toHaveBeenCalledWith({ message: 'App locked' })
  })

  it('handles remove account from device action', async () => {
    const { result } = renderHook(() => useSettings(mockItems))

    await act(async () => {
      await result.current.actions.handleRemoveAccountFromDevice()
    })

    expect(mocks.removeVaultFromDevice).toHaveBeenCalledTimes(1)
    expect(mocks.setMessage).toHaveBeenCalledWith({ message: 'Signed out and removed local data' })
  })

  it('saves auto-lock settings and displays updated summary', async () => {
    const { result } = renderHook(() => useSettings(mockItems))

    act(() => {
      result.current.actions.saveAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    })

    expect(mocks.setMessage).toHaveBeenCalledWith({ message: 'Auto-lock settings saved' })
    expect(result.current.values.autoLockSummary).toBe('When app loses focus')
  })
})
