import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UnsyncedChanges } from '@vault/client'
import RemoveAccountDialog from './RemoveAccountDialog'
import { SyncBridge } from '../../app/vault/syncBridge'
import * as syncBridgeModule from '../../app/vault/syncBridge'
import { spyOnExports } from '../../utils/testUtils'

const getUnsyncedChanges = vi.fn<() => Promise<UnsyncedChanges>>()

beforeEach(() => {
  spyOnExports(syncBridgeModule, {
    SyncBridge: { getUnsyncedChanges },
  })
})

describe('RemoveAccountDialog', () => {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const onExport = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function show() {
    return render(
      <RemoveAccountDialog open onCancel={onCancel} onConfirm={onConfirm} onExport={onExport} />,
    )
  }

  function confirmButton() {
    return screen.getByRole('button', { name: /sign out &/i }) as HTMLButtonElement
  }

  it('waits for the unsynced check before allowing removal', async () => {
    let resolve!: (changes: UnsyncedChanges) => void
    getUnsyncedChanges.mockReturnValue(new Promise(r => { resolve = r }))
    show()

    expect(screen.getByText(/checking for changes/i)).toBeDefined()
    expect(confirmButton().disabled).toBe(true)

    resolve({ pendingItems: 0, quarantinedItems: 0 })

    await waitFor(() => expect(confirmButton().disabled).toBe(false))
    expect(confirmButton().textContent).toMatch(/sign out & remove data/i)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('warns about unsynced changes and requires acknowledging their loss, without blocking removal', async () => {
    getUnsyncedChanges.mockResolvedValue({ pendingItems: 3, quarantinedItems: 1 })
    show()

    expect(await screen.findByText(/3 items on this device have changes that haven't synced yet/i)).toBeDefined()
    expect(screen.getByText(/1 item can't sync and needs recovery/i)).toBeDefined()
    expect(confirmButton().textContent).toMatch(/discard changes/i)
    expect(confirmButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /unsynced changes will be lost/i }))
    expect(confirmButton().disabled).toBe(false)

    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('offers a backup export when changes would be lost', async () => {
    getUnsyncedChanges.mockResolvedValue({ pendingItems: 1, quarantinedItems: 0 })
    show()

    fireEvent.click(await screen.findByRole('button', { name: /export backup/i }))

    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('treats a failed check as possibly unsynced', async () => {
    getUnsyncedChanges.mockRejectedValue(new Error('worker unavailable'))
    show()

    expect(await screen.findByText(/couldn't check whether every change/i)).toBeDefined()
    expect(confirmButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(confirmButton().disabled).toBe(false)
  })

  it('asks for a fresh acknowledgement each time it opens', async () => {
    getUnsyncedChanges.mockResolvedValue({ pendingItems: 1, quarantinedItems: 0 })
    const { rerender } = show()
    fireEvent.click(await screen.findByRole('checkbox'))

    rerender(<RemoveAccountDialog open={false} onCancel={onCancel} onConfirm={onConfirm} onExport={onExport} />)
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull())
    rerender(<RemoveAccountDialog open onCancel={onCancel} onConfirm={onConfirm} onExport={onExport} />)

    await waitFor(() => expect(SyncBridge.getUnsyncedChanges).toHaveBeenCalledTimes(2))
    expect(((await screen.findByRole('checkbox')) as HTMLInputElement).checked).toBe(false)
    expect(confirmButton().disabled).toBe(true)
  })
})
