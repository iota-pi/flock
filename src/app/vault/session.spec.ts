import {
  handleVaultLockedElsewhere,
  handleVaultRemovedElsewhere,
  LocalDataRemovalError,
  loadAccount,
  lockVault,
  lockVaultEverywhere,
  removeVaultFromDevice,
} from './session'
import { SyncBridge } from './syncBridge'
import {
  announceVaultLocked,
  announceVaultRemoved,
  clearVaultDeviceData,
  lockVaultKeys,
  readStoredMetadata,
} from '@vault/client'
import { clearManualLock, isManualLock } from './autoLockStore'
import { unsubscribe } from '../../utils/pushNotifications'
import * as syncBridgeModule from './syncBridge'
import * as clientModule from '@vault/client'
import * as pushNotificationsModule from '../../utils/pushNotifications'
import { deferMigration, isMigrationDeferred } from '../../migrate/detection'
import * as storeModule from '../../state/store'
import { spyOnExports } from '../../utils/testUtils'

const mocks = {
  updateAuth: vi.fn(),
  setMessage: vi.fn(),
  state: { account: 'acct-1', loggedIn: true },
}

beforeEach(() => {
  spyOnExports(syncBridgeModule, {
    SyncBridge: {
      shutdown: vi.fn().mockResolvedValue(undefined),
      requestClearOnShutdown: vi.fn(),
    },
  })
  spyOnExports(clientModule, {
    clearVaultDeviceData: vi.fn().mockResolvedValue(undefined),
    lockVaultKeys: vi.fn().mockResolvedValue(undefined),
    readStoredMetadata: vi.fn(),
    announceVaultLocked: vi.fn(),
    announceVaultRemoved: vi.fn(),
  })
  spyOnExports(pushNotificationsModule, {
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(storeModule, {
    useAppStore: {
      getState: () => ({ ...mocks.state, updateAuth: mocks.updateAuth, setMessage: mocks.setMessage }),
    },
  })
})

describe('vault session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.account = 'acct-1'
    mocks.state.loggedIn = true
    clearManualLock()
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

  it('removeVaultFromDevice forgets a deferred migration for the account only', async () => {
    deferMigration('acct-1')
    deferMigration('acct-2')

    await removeVaultFromDevice()

    expect(isMigrationDeferred('acct-1')).toBe(false)
    expect(isMigrationDeferred('acct-2')).toBe(true)
    localStorage.clear()
  })

  it('removeVaultFromDevice still clears vault data when unsubscribing fails', async () => {
    vi.mocked(unsubscribe).mockRejectedValueOnce(new Error('offline'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await removeVaultFromDevice()

    expect(clearVaultDeviceData).toHaveBeenCalledWith('acct-1')
    consoleError.mockRestore()
  })

  it('removeVaultFromDevice asks other tabs to lock before shutting sync down', async () => {
    const order: string[] = []
    vi.mocked(announceVaultRemoved).mockImplementation(() => { order.push('announce') })
    vi.mocked(SyncBridge.shutdown).mockImplementation(async () => { order.push('shutdown') })

    await removeVaultFromDevice()

    expect(announceVaultRemoved).toHaveBeenCalledWith('acct-1')
    expect(order).toEqual(['announce', 'shutdown'])
  })

  it('removeVaultFromDevice signs out and clears what it can, then reports a failed clear', async () => {
    vi.mocked(SyncBridge.shutdown).mockRejectedValueOnce(new Error('database blocked'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(removeVaultFromDevice()).rejects.toBeInstanceOf(LocalDataRemovalError)

    expect(clearVaultDeviceData).toHaveBeenCalledWith('acct-1')
    expect(mocks.updateAuth).toHaveBeenCalledWith({ account: '', loggedIn: false })
    consoleError.mockRestore()
  })

  it('removeVaultFromDevice reports a failure to clear vault device data', async () => {
    vi.mocked(clearVaultDeviceData).mockRejectedValueOnce(new Error('quota'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(removeVaultFromDevice()).rejects.toBeInstanceOf(LocalDataRemovalError)

    expect(mocks.updateAuth).toHaveBeenCalledWith({ account: '', loggedIn: false })
    consoleError.mockRestore()
  })

  it('lockVaultEverywhere asks other tabs to lock and locks this one', async () => {
    await lockVaultEverywhere()

    expect(announceVaultLocked).toHaveBeenCalledWith('acct-1')
    expect(isManualLock()).toBe(true)
    expect(lockVaultKeys).toHaveBeenCalledTimes(1)
    expect(mocks.updateAuth).toHaveBeenCalledWith({ loggedIn: false })
  })

  it('handleVaultLockedElsewhere locks this tab without announcing it again', async () => {
    await handleVaultLockedElsewhere('acct-1')

    expect(lockVaultKeys).toHaveBeenCalledTimes(1)
    expect(isManualLock()).toBe(true)
    expect(announceVaultLocked).not.toHaveBeenCalled()
    expect(mocks.setMessage).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/another tab/) }))
  })

  it('handleVaultLockedElsewhere ignores other accounts and locked tabs', async () => {
    await handleVaultLockedElsewhere('acct-2')
    mocks.state.loggedIn = false
    await handleVaultLockedElsewhere('acct-1')

    expect(lockVaultKeys).not.toHaveBeenCalled()
  })

  it('handleVaultRemovedElsewhere locks this tab and forgets the account', async () => {
    await handleVaultRemovedElsewhere('acct-1')

    expect(lockVaultKeys).toHaveBeenCalledTimes(1)
    expect(SyncBridge.shutdown).toHaveBeenCalledWith({ clearLocalData: false })
    expect(mocks.updateAuth).toHaveBeenLastCalledWith({ account: '', loggedIn: false })
    expect(announceVaultRemoved).not.toHaveBeenCalled()
  })

  it('handleVaultRemovedElsewhere forgets the account on a locked tab', async () => {
    mocks.state.loggedIn = false
    await handleVaultRemovedElsewhere('acct-1')

    expect(lockVaultKeys).not.toHaveBeenCalled()
    expect(mocks.updateAuth).toHaveBeenCalledWith({ account: '', loggedIn: false })
  })

  it('handleVaultRemovedElsewhere ignores other accounts', async () => {
    await handleVaultRemovedElsewhere('acct-2')

    expect(mocks.updateAuth).not.toHaveBeenCalled()
  })
})
