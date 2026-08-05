import { useAppStore } from '../store'


vi.mock('../api/db', () => ({
  syncDB: {
    removeItem: vi.fn(async () => undefined),
  },
}))

describe('authSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      account: '',
      loggedIn: false,
      initializing: true,
    })
  })

  it('resets auth state cleanly on logout-style payload', () => {
    useAppStore.getState().updateAuth({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })

    useAppStore.getState().updateAuth({
      account: '',
      loggedIn: false,
    })

    expect(useAppStore.getState()).toMatchObject({
      account: '',
      loggedIn: false,
      initializing: false,
    })
  })

  it('handles token-refresh-like concurrent updates without clobbering state', async () => {
    await Promise.all([
      Promise.resolve().then(() => useAppStore.getState().updateAuth({ account: 'acct-1' })),
      Promise.resolve().then(() => useAppStore.getState().updateAuth({ loggedIn: true })),
      Promise.resolve().then(() => useAppStore.getState().updateAuth({ initializing: false })),
    ])

    expect(useAppStore.getState()).toMatchObject({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })
  })
})
