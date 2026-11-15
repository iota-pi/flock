import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IncorrectPasswordError } from '@vault/client'
import DeleteAccountDialog from './DeleteAccountDialog'
import * as accountDeletionModule from '../../app/vault/accountDeletion'
import * as sessionModule from '../../app/vault/session'
import * as syncBridgeModule from '../../app/vault/syncBridge'
import { useAppStore } from '../../state/store'
import { spyOnExports } from '../../utils/testUtils'
import { checkA11y } from '../../testUtils/axe'

const setMessage = vi.fn()
const exportAllBinaries = vi.fn()
let startAccountDeletion: ReturnType<typeof vi.spyOn>
let deleteServerData: ReturnType<typeof vi.spyOn>
let deleteServerAccount: ReturnType<typeof vi.spyOn>
let removeVaultFromDevice: ReturnType<typeof vi.spyOn>
let originalState: ReturnType<typeof useAppStore.getState>

beforeEach(() => {
  vi.clearAllMocks()
  startAccountDeletion = vi.spyOn(accountDeletionModule, 'startAccountDeletion').mockResolvedValue('auth-token')
  deleteServerData = vi.spyOn(accountDeletionModule, 'deleteServerData').mockResolvedValue(undefined)
  deleteServerAccount = vi.spyOn(accountDeletionModule, 'deleteServerAccount').mockResolvedValue(undefined)
  removeVaultFromDevice = vi.spyOn(sessionModule, 'removeVaultFromDevice').mockResolvedValue(undefined)
  originalState = useAppStore.getState()
  spyOnExports(syncBridgeModule, { SyncBridge: { exportAllBinaries } })
  exportAllBinaries.mockRejectedValue(new Error('not in this test'))
  useAppStore.setState({ account: 'acct-1', setMessage, deleteAccountOpen: true })
})

afterEach(() => {
  useAppStore.setState(originalState, true)
  vi.restoreAllMocks()
})

function show() {
  return render(<DeleteAccountDialog />)
}

function isOpen() {
  return useAppStore.getState().deleteAccountOpen
}

function deleteButton() {
  return screen.getByRole('button', { name: /^delete account$/i }) as HTMLButtonElement
}

function confirmDeletion(password = 'hunter2') {
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(deleteButton())
}

describe('DeleteAccountDialog', () => {
  it('explains what deleting does and passes accessibility audits', async () => {
    const { container } = show()

    expect(screen.getByText(/can't be undone/i)).toBeDefined()
    expect(screen.getByText(/delete all of your people, groups, notes and prayer history/i)).toBeDefined()
    expect(screen.getByText(/stop your prayer reminders/i)).toBeDefined()
    await checkA11y(container)
  })

  it('needs the password and an acknowledgement before deleting', () => {
    show()

    expect(deleteButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'hunter2' } })
    expect(deleteButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(deleteButton().disabled).toBe(false)
  })

  it('offers a backup export', async () => {
    show()

    fireEvent.click(screen.getByRole('button', { name: /export/i }))

    await waitFor(() => expect(exportAllBinaries).toHaveBeenCalledTimes(1))
  })

  it('closes on cancel', () => {
    show()

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(isOpen()).toBe(false)
  })

  it('deletes server data, then the account, then local data, and reports success', async () => {
    show()

    confirmDeletion()

    await waitFor(() => expect(isOpen()).toBe(false))
    expect(startAccountDeletion).toHaveBeenCalledWith('acct-1', 'hunter2')
    expect(deleteServerData).toHaveBeenCalledWith('acct-1', 'auth-token')
    expect(deleteServerAccount).toHaveBeenCalledWith('acct-1', 'auth-token')
    expect(deleteServerData.mock.invocationCallOrder[0]).toBeLessThan(deleteServerAccount.mock.invocationCallOrder[0])
    expect(deleteServerAccount.mock.invocationCallOrder[0]).toBeLessThan(removeVaultFromDevice.mock.invocationCallOrder[0])
    expect(removeVaultFromDevice).toHaveBeenCalledWith({ accountDeleted: true })
    expect(setMessage).toHaveBeenCalledWith({ severity: 'success', message: 'Your account has been deleted.' })
  })

  it('stops with nothing deleted when the password is wrong', async () => {
    startAccountDeletion.mockRejectedValueOnce(new IncorrectPasswordError())
    show()

    confirmDeletion('wrong')

    expect(await screen.findByText(/incorrect password\. nothing has been deleted/i)).toBeDefined()
    expect(deleteServerData).not.toHaveBeenCalled()
    expect(removeVaultFromDevice).not.toHaveBeenCalled()
    expect(isOpen()).toBe(true)
  })

  it('offers to retry deleting data that could not be deleted', async () => {
    deleteServerData.mockRejectedValueOnce(new Error('offline'))
    show()

    confirmDeletion()
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))

    await waitFor(() => expect(isOpen()).toBe(false))
    expect(deleteServerData).toHaveBeenCalledTimes(2)
    // The password is checked once, and its token reused
    expect(startAccountDeletion).toHaveBeenCalledTimes(1)
    expect(setMessage).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }))
  })

  it('carries on deleting the account when the user continues past data it could not delete', async () => {
    deleteServerData.mockRejectedValueOnce(new Error('offline'))
    show()

    confirmDeletion()
    expect(await screen.findByText(/couldn't delete all of your data/i)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }))

    await waitFor(() => expect(isOpen()).toBe(false))
    expect(deleteServerAccount).toHaveBeenCalledTimes(1)
    expect(removeVaultFromDevice).toHaveBeenCalledTimes(1)
    expect(setMessage).toHaveBeenCalledWith(accountDeletionModule.describeDeletionOutcome({ itemsLeft: true, accountLeft: false, localFailed: false }))
  })

  it('warns when the account could not be deleted, then removes local data if the user continues', async () => {
    deleteServerAccount.mockRejectedValueOnce(new Error('offline'))
    show()

    confirmDeletion()
    expect(await screen.findByText(/couldn't delete your account itself/i)).toBeDefined()
    expect(removeVaultFromDevice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /continue anyway/i }))

    await waitFor(() => expect(isOpen()).toBe(false))
    // The account is still on the server, so the session can still turn its reminders off there
    expect(removeVaultFromDevice).toHaveBeenCalledWith({ accountDeleted: false })
    expect(setMessage).toHaveBeenCalledWith(accountDeletionModule.describeDeletionOutcome({ itemsLeft: false, accountLeft: true, localFailed: false }))
  })

  it('reports local data it could not remove', async () => {
    removeVaultFromDevice.mockRejectedValueOnce(new sessionModule.LocalDataRemovalError([]))
    show()

    confirmDeletion()

    await waitFor(() => expect(isOpen()).toBe(false))
    expect(setMessage).toHaveBeenCalledWith({
      severity: 'warning',
      message: expect.stringMatching(/clear this site's data/),
    })
  })
})
