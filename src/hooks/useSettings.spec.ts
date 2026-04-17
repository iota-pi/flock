import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useSettings from './useSettings'

const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  signOutVault: vi.fn(),
  storeItems: vi.fn(),
  setMetadata: vi.fn(),
  clearMetadataCache: vi.fn(),
  getCachedMetadata: vi.fn(() => ({ meta: 'value' })),
  exportAllBinaries: vi.fn(() => ({ i1: 'base64-doc' })),
  restoreFromBinaries: vi.fn(async () => ['i1']),
  clearAutomergeDocStore: vi.fn(async () => undefined),
  getAutomergeItems: vi.fn(() => []),
  getAutomergeMetadata: vi.fn(() => ({})),
  requestAutomergeSync: vi.fn(),
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
  useItems: () => [{ id: 'i1', type: 'person', name: 'N', archived: false }],
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

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: mocks.requestAutomergeSync,
}))

vi.mock('../api/itemReadService', () => ({
  clearMetadataCache: mocks.clearMetadataCache,
  getCachedMetadata: mocks.getCachedMetadata,
}))

vi.mock('../sync/automergeDocStore', () => ({
  clearAutomergeDocStore: mocks.clearAutomergeDocStore,
  exportAllBinaries: mocks.exportAllBinaries,
  getAutomergeItems: mocks.getAutomergeItems,
  getAutomergeMetadata: mocks.getAutomergeMetadata,
  restoreFromBinaries: mocks.restoreFromBinaries,
}))

describe('useSettings backup portability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports metadata and automerge binaries in a v2 payload', async () => {
    mocks.exportData.mockImplementation(async (payload: unknown) => payload)

    const { result } = renderHook(() => useSettings())

    let json = ''
    await act(async () => {
      json = await result.current.actions.handleExport()
    })

    const parsed = JSON.parse(json)
    expect(parsed).toMatchObject({
      version: 2,
      documents: { i1: 'base64-doc' },
    })
  })

  it('restores metadata and binaries without queue side effects', async () => {
    mocks.restoreFromBinaries.mockResolvedValue(['i1'])
    mocks.setMetadata.mockResolvedValue(undefined)

    const { result } = renderHook(() => useSettings())

    await act(async () => {
      await result.current.actions.handleConfirmRestore({
        version: 2,
        metadata: {},
        documents: { i1: 'base64-doc' },
      })
    })

    expect(mocks.setMetadata).toHaveBeenCalledTimes(1)
    expect(mocks.restoreFromBinaries).toHaveBeenCalledTimes(1)
    expect(mocks.storeItems).not.toHaveBeenCalled()
  })
})
