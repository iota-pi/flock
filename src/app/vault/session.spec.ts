import { loadAccount, lockVault, removeVaultFromDevice } from './session'
import { SyncBridge } from './syncBridge'
import { clearVaultDeviceData, lockVaultKeys, readStoredMetadata } from '../../api/vault'
import { unsubscribe } from '../../utils/pushNotifications'

const mocks = vi.hoisted(() => ({
  updateAuth: vi.fn(),
  state: { account: 'acct-1' },
}))

vi.mock('./syncBridge', () => ({
  SyncBridge: {
    shutdown: vi.fn().mockResolvedValue(undefined),
    requestClearOnShutdown: vi.fn(),
  },
}))

vi.mock('../../api/vault', () => ({
  clearVaultDeviceData: vi.fn().mockResolvedValue(undefined),
  lockVaultKeys: vi.fn().mockResolvedValue(undefined),
  readStoredMetadata: vi.fn(),
}))

vi.mock('../../utils/pushNotifications', () => ({
  unsubscribe: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../state/store', () => ({
  useAppStore: {
    getState: () => ({ ...mocks.state, updateAuth: mocks.updateAuth }),
  },
}))

describe('vault session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.account = 'acct-1'
  })

  it('loadAccount restores the stored account', async () => {
    vi.mocked(readStoredMetadata).mockReturnValue({ account: 'acct-1' })

    await loadAccount()

    expect(mocks.updateAuth).toHaveBeenCalledWith({ account: 'acct-1', initializing: false })
  })

  it('loadAccount finishes initializing when there is no stored account', async () => {
    vi.mocked(readStoredMetadata).mockReturnValue(null)

    await loadAccount()

    expect(mocks.updateAuth).toHaveBeenCalledWith({ initializing: false })
  })

  it('lockVault forgets keys, stops sync without clearing local data and logs out', async () => {
    await lockVault()

    expect(lockVaultKeys).toHaveBeenCalledTimes(1)
    expect(SyncBridge.shutdown).toHaveBeenCalledWith({ clearLocalData: false })
    expect(mocks.updateAuth).toHaveBeenCalledWith({ loggedIn: false })
  })

  it('removeVaultFromDevice clears local sync data, unsubscribes and removes vault data', async () => {
    await removeVaultFromDevice()

    expect(SyncBridge.requestClearOnShutdown).toHaveBeenCalledWith('acct-1')
    expect(SyncBridge.shutdown).toHaveBeenCalledWith({ clearLocalData: true, accountId: 'acct-1' })
    expect(unsubscribe).toHaveBeenCalledWith('acct-1')
    expect(clearVaultDeviceData).toHaveBeenCalledWith('acct-1')
    expect(mocks.updateAuth).toHaveBeenCalledWith({ account: '', loggedIn: false })
  })

  it('removeVaultFromDevice still clears vault data when unsubscribing fails', async () => {
    vi.mocked(unsubscribe).mockRejectedValueOnce(new Error('offline'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await removeVaultFromDevice()

    expect(clearVaultDeviceData).toHaveBeenCalledWith('acct-1')
    consoleError.mockRestore()
  })
})
