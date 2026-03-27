import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncDB } from '../api/db'
import { ACTIVE_SESSION_TOKEN_KEY, OFFLINE_QUEUE_KEY } from '../api/offlineQueueStore'
import { clearPersistedAuthSyncState, useAuthStore } from './authStore'

vi.mock('../api/db', () => ({
  syncDB: {
    removeItem: vi.fn(async () => undefined),
  },
}))

describe('authStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
      account: '',
      loggedIn: false,
      initializing: true,
    })
  })

  it('resets auth state cleanly on logout-style payload', () => {
    useAuthStore.getState().setAccount({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })

    useAuthStore.getState().setAccount({
      account: '',
      loggedIn: false,
    })

    expect(useAuthStore.getState()).toMatchObject({
      account: '',
      loggedIn: false,
      initializing: false,
    })
  })

  it('handles token-refresh-like concurrent updates without clobbering state', async () => {
    await Promise.all([
      Promise.resolve().then(() => useAuthStore.getState().setAccount({ account: 'acct-1' })),
      Promise.resolve().then(() => useAuthStore.getState().setAccount({ loggedIn: true })),
      Promise.resolve().then(() => useAuthStore.getState().setAccount({ initializing: false })),
    ])

    expect(useAuthStore.getState()).toMatchObject({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })
  })

  it('clears persisted session and offline queue sync keys', async () => {
    await clearPersistedAuthSyncState()

    expect(syncDB.removeItem).toHaveBeenCalledWith(ACTIVE_SESSION_TOKEN_KEY)
    expect(syncDB.removeItem).toHaveBeenCalledWith(OFFLINE_QUEUE_KEY)
    expect(syncDB.removeItem).toHaveBeenCalledTimes(2)
  })
})
