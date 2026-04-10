import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncStore } from '../state/syncStore'

const mocks = vi.hoisted(() => ({
  listAutomergeDocumentIds: vi.fn(() => ['doc-1']),
  registerKnownItemIds: vi.fn(),
  syncItemIds: vi.fn(),
  setVaultNetworkAccount: vi.fn(),
}))

vi.mock('./automergeDocStore', () => ({
  listAutomergeDocumentIds: mocks.listAutomergeDocumentIds,
}))

vi.mock('./automergeRepo', () => ({
  getVaultNetworkAdapter: () => ({
    registerKnownItemIds: mocks.registerKnownItemIds,
    syncItemIds: mocks.syncItemIds,
  }),
  setVaultNetworkAccount: mocks.setVaultNetworkAccount,
}))

import {
  pullRemoteMessagesNow,
  requestAutomergeSync,
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'

function resetSyncState(): void {
  useSyncStore.setState({
    activeAccount: null,
    fatalError: null,
    isSyncing: false,
    syncWarning: null,
  })
}

describe('automergeSyncDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSyncState()
  })

  it('throws sync dispatcher errors only in test mode when inactive', () => {
    expect(() => requestAutomergeSync(['doc-1'])).toThrow('Sync dispatcher is not active')
    expect(mocks.registerKnownItemIds).toHaveBeenCalledWith(['doc-1'])
  })

  it('tracks active account in sync store', async () => {
    startAutomergeSyncDispatcher('acct-1')

    expect(useSyncStore.getState().activeAccount).toBe('acct-1')
    expect(mocks.setVaultNetworkAccount).toHaveBeenCalledWith('acct-1')

    await pullRemoteMessagesNow(['doc-1'])
    expect(mocks.syncItemIds).toHaveBeenCalledWith(['doc-1'])

    stopAutomergeSyncDispatcher()

    expect(useSyncStore.getState().activeAccount).toBeNull()
    expect(mocks.setVaultNetworkAccount).toHaveBeenCalledWith(null)
  })
})
