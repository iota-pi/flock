import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncStore } from '../state/syncStore'
import { useAuthStore, getInitialAuthState } from '../state/authStore'

const mocks = vi.hoisted(() => ({
  listAutomergeDocumentIds: vi.fn(() => ['doc-1']),
  resolvePendingAutomergeHandles: vi.fn(),
  syncKnownAutomergeItemIds: vi.fn(),
  setVaultNetworkAccount: vi.fn(),
}))

vi.mock('./automergeDocStore', () => ({
  listAutomergeDocumentIds: mocks.listAutomergeDocumentIds,
  resolvePendingAutomergeHandles: mocks.resolvePendingAutomergeHandles,
}))

vi.mock('./automergeRepo', () => ({
  setVaultNetworkAccount: mocks.setVaultNetworkAccount,
  syncKnownAutomergeItemIds: mocks.syncKnownAutomergeItemIds,
}))

import {
  pullRemoteMessagesNow,
  requestAutomergeSync,
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'

function resetSyncState(): void {
  useSyncStore.setState({
    fatalError: null,
    isSyncing: false,
    syncWarning: null,
  })
  useAuthStore.setState(getInitialAuthState())
}

describe('automergeSyncDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSyncState()
  })

  it('throws sync dispatcher errors only in test mode when inactive', () => {
    expect(() => requestAutomergeSync(['doc-1'])).toThrow('Sync dispatcher is not active')
  })

  it('tracks active account in auth store internally logic but tests setVaultNetworkAccount', async () => {
    useAuthStore.setState({ account: 'acct-1' })
    startAutomergeSyncDispatcher('acct-1')

    expect(mocks.setVaultNetworkAccount).toHaveBeenCalledWith('acct-1')
    expect(mocks.syncKnownAutomergeItemIds).toHaveBeenCalledWith(undefined, 'acct-1')

    await pullRemoteMessagesNow(undefined, ['doc-1'])
    expect(mocks.syncKnownAutomergeItemIds).toHaveBeenLastCalledWith(undefined, 'acct-1')

    useAuthStore.setState({ account: '' })
    stopAutomergeSyncDispatcher()

    expect(mocks.setVaultNetworkAccount).toHaveBeenCalledWith(null)
  })

  it('unblocks queued sync requests when a sync call times out', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.useFakeTimers()
    useAuthStore.setState({ account: 'acct-1' })

    mocks.syncKnownAutomergeItemIds
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValueOnce(undefined)

    requestAutomergeSync(['doc-1'])
    requestAutomergeSync(['doc-2'])

    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.syncKnownAutomergeItemIds).toHaveBeenCalledTimes(2)
    expect(mocks.syncKnownAutomergeItemIds).toHaveBeenNthCalledWith(1, undefined, 'acct-1')
    expect(mocks.syncKnownAutomergeItemIds).toHaveBeenNthCalledWith(2, undefined, 'acct-1')

    vi.useRealTimers()
    errorSpy.mockRestore()
  })
})
