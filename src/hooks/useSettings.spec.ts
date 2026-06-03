import { act, renderHook } from '@testing-library/react'

import useSettings from './useSettings'
import type { Item } from 'src/state/items'


const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  signOutVault: vi.fn(),
  storeItems: vi.fn(),
  setMetadata: vi.fn(),

  exportAllBinaries: vi.fn(() => ({ i1: 'base64-doc' })),
  restoreFromBinaries: vi.fn(async () => ['i1']),
  clearAutomergeDocStore: vi.fn(async () => undefined),
  exportSyncState: vi.fn(async () => ({ cursors: [], pendingSync: [], lastModified: [] })),
  restoreSyncState: vi.fn(async () => undefined),
  forceSync: vi.fn(async () => undefined),
  setMessage: vi.fn(),
  setUi: vi.fn(),
}))

vi.mock('../api/vault', () => ({
  exportData: mocks.exportData,
  signOutVault: mocks.signOutVault,
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

vi.mock('../state/uiStore', () => ({
  useUiStore: (selector: (state: {
    setUi: typeof mocks.setUi
    darkMode: boolean | null
  }) => unknown) => selector({
    setUi: mocks.setUi,
    darkMode: null,
  }),
}))

vi.mock('../state/toastStore', () => ({
  useToastStore: (selector: (state: {
    setMessage: typeof mocks.setMessage
  }) => unknown) => selector({
    setMessage: mocks.setMessage,
  }),
}))

vi.mock('../state/syncStore', () => ({
  useSyncStore: {
    getState: () => ({}),
  },
}))


vi.mock('../sync/SyncBridge', () => ({
  SyncBridge: {
    clearAutomergeDocStore: mocks.clearAutomergeDocStore,
    exportAllBinaries: mocks.exportAllBinaries,
    restoreFromBinaries: mocks.restoreFromBinaries,
    exportSyncState: mocks.exportSyncState,
    restoreSyncState: mocks.restoreSyncState,
    forceSync: mocks.forceSync,
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
      cursors: [['i1', 10]],
      pendingSync: [['i1', ['msg1']]],
      lastModified: [['i1', 12345]]
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

  it('restores metadata, binaries, and sync state without queue side effects', async () => {
    mocks.restoreFromBinaries.mockResolvedValue(['i1'])
    mocks.setMetadata.mockResolvedValue(undefined)

    const { result } = renderHook(() => useSettings(mockItems))

    await act(async () => {
      await result.current.actions.handleConfirmRestore({
        version: 2,
        metadata: {},
        documents: { i1: 'base64-doc' },
        cursors: [['i1', 10]],
        pendingSync: [['i1', ['msg1']]],
        lastModified: [['i1', 12345]]
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
})
