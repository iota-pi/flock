import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSyncStore } from '../state/syncStore'

const mocks = vi.hoisted(() => ({
  setVaultNetworkAccount: vi.fn(),
}))

vi.mock('./automergeRepo', () => ({
  setVaultNetworkAccount: mocks.setVaultNetworkAccount,
}))

import {
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'

function resetSyncState(): void {
  useSyncStore.setState({
    fatalError: null,
    status: 'idle',
    syncWarning: null,
  })
}

describe('automergeSyncDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSyncState()
  })

  it('starts vault network account wiring when account is present', () => {
    startAutomergeSyncDispatcher('acct-1')

    expect(mocks.setVaultNetworkAccount).toHaveBeenCalledWith('acct-1')
  })

  it('ignores dispatcher start when account is empty', () => {
    startAutomergeSyncDispatcher('')

    expect(mocks.setVaultNetworkAccount).not.toHaveBeenCalled()
  })

  it('stops vault network account wiring and clears syncing state', () => {
    useSyncStore.getState().setSyncStatus('syncing')

    stopAutomergeSyncDispatcher()

    expect(mocks.setVaultNetworkAccount).toHaveBeenCalledWith(null)
    expect(useSyncStore.getState().status).toBe('idle')
  })
})
