import { resolveVaultTableNames } from './config'

describe('resolveVaultTableNames', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers explicit names, then environment variables, then defaults', () => {
    vi.stubEnv('ACCOUNTS_TABLE', 'EnvAccounts')
    vi.stubEnv('ITEMS_TABLE', 'EnvItems')
    vi.stubEnv('SYNC_MESSAGES_TABLE', '')

    const tables = resolveVaultTableNames(
      { accounts: 'ExplicitAccounts' },
      { accounts: 'DefaultAccounts', items: 'DefaultItems', syncMessages: 'DefaultSyncMessages' },
    )

    expect(tables).toEqual({
      accounts: 'ExplicitAccounts',
      items: 'EnvItems',
      syncMessages: 'DefaultSyncMessages',
    })
  })

  it('throws when a table has no name', () => {
    vi.stubEnv('SYNC_MESSAGES_TABLE', '')

    expect(() => resolveVaultTableNames({ accounts: 'A', items: 'I' })).toThrow('SYNC_MESSAGES_TABLE')
  })
})
