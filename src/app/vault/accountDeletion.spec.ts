import { IncorrectPasswordError } from '@vault/client'
import * as clientModule from '@vault/client'
import { deleteServerAccount, deleteServerData, startAccountDeletion } from './accountDeletion'
import * as syncBridgeModule from './syncBridge'
import { spyOnExports } from '../../utils/testUtils'

const mocks = {
  shutdown: vi.fn(),
  confirmAccountPassword: vi.fn(),
  deleteAccountItems: vi.fn(),
  deleteAccountRecord: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.shutdown.mockResolvedValue(undefined)
  mocks.confirmAccountPassword.mockResolvedValue('auth-token')
  mocks.deleteAccountItems.mockResolvedValue(undefined)
  mocks.deleteAccountRecord.mockResolvedValue(undefined)
  spyOnExports(syncBridgeModule, { SyncBridge: { shutdown: mocks.shutdown } })
  spyOnExports(clientModule, {
    confirmAccountPassword: mocks.confirmAccountPassword,
    deleteAccountItems: mocks.deleteAccountItems,
    deleteAccountRecord: mocks.deleteAccountRecord,
  })
})

describe('account deletion', () => {
  it('checks the password, then stops sync without clearing local data', async () => {
    await expect(startAccountDeletion('acct-1', 'hunter2')).resolves.toBe('auth-token')

    expect(mocks.confirmAccountPassword).toHaveBeenCalledWith('acct-1', 'hunter2')
    expect(mocks.shutdown).toHaveBeenCalledWith({ clearLocalData: false })
    expect(mocks.confirmAccountPassword.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.shutdown.mock.invocationCallOrder[0])
  })

  it('leaves sync running when the password is wrong', async () => {
    mocks.confirmAccountPassword.mockRejectedValueOnce(new IncorrectPasswordError())

    await expect(startAccountDeletion('acct-1', 'wrong')).rejects.toBeInstanceOf(IncorrectPasswordError)
    expect(mocks.shutdown).not.toHaveBeenCalled()
  })

  it('deletes server data and the account record with the confirmed password', async () => {
    await deleteServerData('acct-1', 'auth-token')
    await deleteServerAccount('acct-1', 'auth-token')

    expect(mocks.deleteAccountItems).toHaveBeenCalledWith({ account: 'acct-1', currentAuthToken: 'auth-token' })
    expect(mocks.deleteAccountRecord).toHaveBeenCalledWith({ account: 'acct-1', currentAuthToken: 'auth-token' })
  })
})
