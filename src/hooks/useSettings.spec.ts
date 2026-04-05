import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useSettings from './useSettings'

const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  signOutVault: vi.fn(),
  mutateStoreItems: vi.fn(),
  mutateSetMetadataView: vi.fn(),
  readQueue: vi.fn(),
  readDeadLetterQueue: vi.fn(),
  writeQueue: vi.fn(),
  writeDeadLetterQueue: vi.fn(),
  registerBackgroundSync: vi.fn(),
  setMessage: vi.fn(),
  setUi: vi.fn(),
  setOfflineQueueLength: vi.fn(),
  setDlqCount: vi.fn(),
}))

vi.mock('../api/vault', () => ({
  exportData: mocks.exportData,
  signOutVault: mocks.signOutVault,
}))

vi.mock('../api/itemMutations', () => ({
  mutateStoreItems: mocks.mutateStoreItems,
  mutateSetMetadata: mocks.mutateSetMetadataView,
}))

vi.mock('../state/selectors', () => ({
  useItems: () => [{ id: 'i1', type: 'person', name: 'N', archived: false }],
  useMetadata: (_key: string, defaultValue?: unknown) => [defaultValue, vi.fn()],
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({ account: 'acct-1', loggedIn: true, initializing: false }),
}))

vi.mock('../state/uiStore', () => ({
  useUiStore: Object.assign(
    (selector: (state: {
      setMessage: typeof mocks.setMessage
      setUi: typeof mocks.setUi
      darkMode: boolean | null
      setOfflineQueueLength: typeof mocks.setOfflineQueueLength
      setDlqCount: typeof mocks.setDlqCount
    }) => unknown) => selector({
      setMessage: mocks.setMessage,
      setUi: mocks.setUi,
      darkMode: null,
      setOfflineQueueLength: mocks.setOfflineQueueLength,
      setDlqCount: mocks.setDlqCount,
    }),
    {
      getState: () => ({
        setOfflineQueueLength: mocks.setOfflineQueueLength,
        setDlqCount: mocks.setDlqCount,
      }),
    },
  ),
}))

vi.mock('../api/queryClient', () => ({
  queryClient: {
    getQueryData: vi.fn(() => ({ meta: 'value' })),
    clear: vi.fn(),
  },
}))

vi.mock('../sync/offlineQueueStore', () => ({
  readQueue: mocks.readQueue,
  readDeadLetterQueue: mocks.readDeadLetterQueue,
  writeQueue: mocks.writeQueue,
  writeDeadLetterQueue: mocks.writeDeadLetterQueue,
}))

vi.mock('../sync/offlineQueue', () => ({
  registerBackgroundSync: mocks.registerBackgroundSync,
}))

describe('useSettings backup portability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('bundles offline queue and dead letter queue in export payload', async () => {
    mocks.readQueue.mockResolvedValue([{ id: 'q1', mutationType: 'items.put', payload: {}, endpoint: 'x' }])
    mocks.readDeadLetterQueue.mockResolvedValue([{ id: 'd1', mutationType: 'items.put', payload: {}, endpoint: 'x' }])
    mocks.exportData.mockImplementation(async (payload: unknown) => payload)

    const { result } = renderHook(() => useSettings())

    let json = ''
    await act(async () => {
      json = await result.current.actions.handleExport()
    })

    const parsed = JSON.parse(json)
    expect(parsed).toMatchObject({
      version: 1,
      offlineQueue: [{ id: 'q1', mutationType: 'items.put', payload: {}, endpoint: 'x' }],
      deadLetterQueue: [{ id: 'd1', mutationType: 'items.put', payload: {}, endpoint: 'x' }],
    })
  })

  it('restores version 1 payloads with or without queue fields', async () => {
    mocks.mutateStoreItems.mockResolvedValue(undefined)
    mocks.writeQueue.mockResolvedValue(undefined)
    mocks.writeDeadLetterQueue.mockResolvedValue(undefined)
    mocks.registerBackgroundSync.mockResolvedValue(undefined)

    const { result } = renderHook(() => useSettings())

    await act(async () => {
      await result.current.actions.handleConfirmRestore({
        items: [{ id: 'i1', type: 'person', name: 'A', archived: false }],
        metadata: { darkMode: true },
      } as any)
    })

    expect(mocks.writeQueue).toHaveBeenCalledWith([])
    expect(mocks.writeDeadLetterQueue).toHaveBeenCalledWith([])
  })
})
