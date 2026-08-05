import { useAuthStore } from './authStore'


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
    useAuthStore.getState().updateAuth({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })

    useAuthStore.getState().updateAuth({
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
      Promise.resolve().then(() => useAuthStore.getState().updateAuth({ account: 'acct-1' })),
      Promise.resolve().then(() => useAuthStore.getState().updateAuth({ loggedIn: true })),
      Promise.resolve().then(() => useAuthStore.getState().updateAuth({ initializing: false })),
    ])

    expect(useAuthStore.getState()).toMatchObject({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })
  })
})
