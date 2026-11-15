import { announceVaultLocked, announceVaultRemoved } from './vaultEvents'
import { configureVaultHost } from './vaultHost'
import { getVaultStorageNames } from '../shared/storageNames'

describe('vault lock and removal events', () => {
  const hooks = {
    onVaultLockedElsewhere: vi.fn(),
    onVaultRemovedElsewhere: vi.fn(),
  }
  let otherTab: BroadcastChannel

  beforeEach(() => {
    vi.clearAllMocks()
    configureVaultHost(hooks)
    otherTab = new BroadcastChannel(getVaultStorageNames().vaultEventsChannel)
  })

  afterEach(() => {
    otherTab.close()
    configureVaultHost({})
  })

  it('tells the host when another tab locks or removes the account', async () => {
    otherTab.postMessage({ type: 'VAULT_LOCKED', account: 'acct-1', source: 'other-tab' })
    otherTab.postMessage({ type: 'VAULT_REMOVED', account: 'acct-1', source: 'other-tab' })

    await vi.waitFor(() => {
      expect(hooks.onVaultLockedElsewhere).toHaveBeenCalledWith('acct-1')
      expect(hooks.onVaultRemovedElsewhere).toHaveBeenCalledWith('acct-1')
    })
  })

  it('announces to other tabs but ignores its own announcements', async () => {
    const received: unknown[] = []
    otherTab.onmessage = event => received.push(event.data)

    announceVaultLocked('acct-1')
    announceVaultRemoved('acct-1')

    await vi.waitFor(() => {
      expect(received).toEqual([
        expect.objectContaining({ type: 'VAULT_LOCKED', account: 'acct-1' }),
        expect.objectContaining({ type: 'VAULT_REMOVED', account: 'acct-1' }),
      ])
    })
    expect(hooks.onVaultLockedElsewhere).not.toHaveBeenCalled()
    expect(hooks.onVaultRemovedElsewhere).not.toHaveBeenCalled()
  })
})
