import { resolveVaultTableNames } from './config'

describe('resolveVaultTableNames', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers explicit names, then environment variables, then defaults', () => {
    vi.stubEnv('ACCOUNTS_TABLE', 'EnvAccounts')
    vi.stubEnv('ITEMS_TABLE', 'EnvItems')
    vi.stubEnv('SYNC_LOG_TABLE', '')

    const tables = resolveVaultTableNames(
      { accounts: 'ExplicitAccounts' },
      { accounts: 'DefaultAccounts', items: 'DefaultItems', syncLog: 'DefaultSyncLog' },
    )

    expect(tables).toEqual({
      accounts: 'ExplicitAccounts',
      items: 'EnvItems',
      syncLog: 'DefaultSyncLog',
    })
  })

  it('throws when a table has no name', () => {
    vi.stubEnv('SYNC_LOG_TABLE', '')

    expect(() => resolveVaultTableNames({ accounts: 'A', items: 'I' })).toThrow('SYNC_LOG_TABLE')
  })
})
