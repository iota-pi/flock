import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import DisplacedDialog from './DisplacedDialog'
import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../app/vault/syncBridge'
import * as syncBridgeModule from '../../app/vault/syncBridge'
import { spyOnExports } from '../../utils/testUtils'

beforeEach(() => {
  spyOnExports(syncBridgeModule, {
    SyncBridge: {
      takeOverHere: vi.fn().mockResolvedValue(undefined),
    },
  })
})

describe('DisplacedDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({ account: 'account-1', displaced: false, message: null })
    })
  })

  function show() {
    act(() => {
      useAppStore.setState({ displaced: true })
    })
    render(<DisplacedDialog />)
  }

  it('stays hidden while this tab has the account', () => {
    render(<DisplacedDialog />)
    expect(screen.queryByText(/open in another tab/i)).toBeNull()
  })

  it('covers the app while another tab has the account, with no way to close it', () => {
    show()

    expect(screen.getByText(/open in another tab/i)).toBeDefined()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByText(/open in another tab/i)).toBeDefined()
  })

  it('takes the account back on "Use here"', async () => {
    show()

    fireEvent.click(screen.getByRole('button', { name: /use here/i }))

    await waitFor(() => {
      expect(SyncBridge.takeOverHere).toHaveBeenCalledWith('account-1')
    })
    expect(useAppStore.getState().displaced).toBe(false)
  })

  it('says why when the account could not be taken back', async () => {
    vi.mocked(SyncBridge.takeOverHere).mockRejectedValueOnce(new Error('Could not start sync'))
    show()

    fireEvent.click(screen.getByRole('button', { name: /use here/i }))

    await waitFor(() => {
      expect(useAppStore.getState().message).toMatchObject({ severity: 'error', message: 'Could not start sync' })
    })
  })
})
