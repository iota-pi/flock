import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LocalDataUnavailableDialog from './LocalDataUnavailableDialog'
import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../app/vault/syncBridge'

vi.mock('../../app/vault/syncBridge', () => ({
  SyncBridge: {
    initialize: vi.fn().mockResolvedValue(undefined),
    discardLocalDataAndRestart: vi.fn().mockResolvedValue(undefined),
  },
}))

describe('LocalDataUnavailableDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({ account: 'account-1', localDataUnavailable: null })
    })
  })

  function show(unpushedChanges: number) {
    act(() => {
      useAppStore.setState({ localDataUnavailable: { unpushedChanges } })
    })
    render(<LocalDataUnavailableDialog />)
  }

  it('stays hidden while local data opens', () => {
    render(<LocalDataUnavailableDialog />)
    expect(screen.queryByText(/data can.t be opened/i)).toBeNull()
  })

  it('tries starting sync again', async () => {
    show(0)

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    await waitFor(() => {
      expect(SyncBridge.initialize).toHaveBeenCalledWith('account-1')
    })
    expect(useAppStore.getState().localDataUnavailable).toBeNull()
  })

  it('discards local data only after the user confirms, saying what would be lost', async () => {
    show(3)

    fireEvent.click(screen.getByRole('button', { name: /discard local data/i }))
    expect(SyncBridge.discardLocalDataAndRestart).not.toHaveBeenCalled()
    expect(screen.getByText(/3 changes made on this device haven't been synced/i)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /discard and download/i }))

    await waitFor(() => {
      expect(SyncBridge.discardLocalDataAndRestart).toHaveBeenCalledWith('account-1')
    })
  })

  it('says when nothing would be lost', () => {
    show(0)

    fireEvent.click(screen.getByRole('button', { name: /discard local data/i }))

    expect(screen.getByText(/nothing will be lost/i)).toBeDefined()
  })
})
