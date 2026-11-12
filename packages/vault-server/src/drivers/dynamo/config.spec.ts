import { resolveVaultTableNames } from './config'

describe('resolveVaultTableNames', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers explicit names, then environment variables, then defaults', () => {
    vi.stubEnv('ACCOUNTS_TABLE', 'EnvAccounts')
    vi.stubEnv('ITEMS_TABLE', 'EnvItems')
    vi.stubEnv('SYNC_LOG_TABLE', '')
    vi.stubEnv('LOGIN_THROTTLE_TABLE', 'EnvLoginThrottle')

    const tables = resolveVaultTableNames(
      { accounts: 'ExplicitAccounts' },
      { accounts: 'DefaultAccounts', items: 'DefaultItems', syncLog: 'DefaultSyncLog' },
    )

    expect(tables).toEqual({
      accounts: 'ExplicitAccounts',
      items: 'EnvItems',
      syncLog: 'DefaultSyncLog',
      loginThrottle: 'EnvLoginThrottle',
    })
  })

  it('throws when a table has no name', () => {
    vi.stubEnv('SYNC_LOG_TABLE', '')
    vi.stubEnv('LOGIN_THROTTLE_TABLE', '')

    expect(() => resolveVaultTableNames({ accounts: 'A', items: 'I', loginThrottle: 'L' })).toThrow('SYNC_LOG_TABLE')
    expect(() => resolveVaultTableNames({ accounts: 'A', items: 'I', syncLog: 'S' })).toThrow('LOGIN_THROTTLE_TABLE')
  })
})
