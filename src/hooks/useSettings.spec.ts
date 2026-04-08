import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useSettings from './useSettings'

const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  signOutVault: vi.fn(),
  mutateStoreItems: vi.fn(),
  mutateSetMetadata: vi.fn(),
  setMessage: vi.fn(),
  setUi: vi.fn(),
}))

vi.mock('../api/vault', () => ({
  exportData: mocks.exportData,
  signOutVault: mocks.signOutVault,
}))

vi.mock('../features/items/mutations/itemMutations', () => ({
  mutateStoreItems: mocks.mutateStoreItems,
  mutateSetMetadata: mocks.mutateSetMetadata,
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

vi.mock('../api/queryClient', () => ({
  queryClient: {
    getQueryData: vi.fn(() => ({ meta: 'value' })),
    clear: vi.fn(),
  },
}))

describe('useSettings backup portability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports metadata and items in a queueless v1 payload', async () => {
    mocks.exportData.mockImplementation(async (payload: unknown) => payload)

    const { result } = renderHook(() => useSettings())

    let json = ''
    await act(async () => {
      json = await result.current.actions.handleExport()
    })

    const parsed = JSON.parse(json)
    expect(parsed).toMatchObject({
      version: 1,
      items: [{ id: 'i1', type: 'person', name: 'N', archived: false }],
    })
  })

  it('restores metadata and items without queue side effects', async () => {
    mocks.mutateStoreItems.mockResolvedValue(undefined)
    mocks.mutateSetMetadata.mockResolvedValue(undefined)

    const { result } = renderHook(() => useSettings())

    await act(async () => {
      await result.current.actions.handleConfirmRestore({
        items: [{ id: 'i1', type: 'person', name: 'A', archived: false }],
        metadata: { darkMode: true },
      } as any)
    })

    expect(mocks.mutateSetMetadata).toHaveBeenCalledTimes(1)
    expect(mocks.mutateStoreItems).toHaveBeenCalledTimes(1)
  })
})
