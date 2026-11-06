import { act, fireEvent, render as renderRaw, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import type { ReactElement } from 'react'
import getTheme from '../../theme'
import SyncStatusIndicator from './SyncStatusIndicator'
import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../app/vault/syncBridge'
import * as syncBridgeModule from '../../app/vault/syncBridge'
import { spyOnExports } from '../../utils/testUtils'
import { checkA11y } from '../../testUtils/axe'

const theme = getTheme(false)

function render(ui: ReactElement) {
  return renderRaw(<ThemeProvider theme={theme}>{ui}</ThemeProvider>)
}

beforeEach(() => {
  spyOnExports(syncBridgeModule, {
    SyncBridge: {
      flushSync: vi.fn().mockResolvedValue(undefined),
    },
  })
})

describe('SyncStatusIndicator', () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ syncStatus: 'idle', syncProgress: null })
    })
  })

  it('shows that everything synced, with the last sync time in the details', async () => {
    act(() => {
      useAppStore.setState({ syncProgress: { pendingItems: 0, quarantinedItems: 0, lastSyncedAt: Date.now() } })
    })
    const { container } = render(<SyncStatusIndicator />)
    await checkA11y(container)

    fireEvent.click(screen.getByRole('button', { name: 'Sync status: All changes synced' }))

    const details = await screen.findByRole('dialog', { name: 'Sync details' })
    expect(details.textContent).toContain('Last synced just now')
  })

  it('shows how many items are waiting while offline', () => {
    act(() => {
      useAppStore.setState({
        syncStatus: 'offline',
        syncProgress: { pendingItems: 2, quarantinedItems: 0, lastSyncedAt: null },
      })
    })
    render(<SyncStatusIndicator />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync status: Offline' }))

    expect(screen.getByText("2 items saved on this device will sync when you're back online")).toBeDefined()
    expect(screen.getByText('Not synced on this device yet')).toBeDefined()
    expect((screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('syncs now on request', async () => {
    act(() => {
      useAppStore.setState({ syncProgress: { pendingItems: 1, quarantinedItems: 0, lastSyncedAt: null } })
    })
    render(<SyncStatusIndicator />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync status: 1 item waiting to sync' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))

    await waitFor(() => expect(SyncBridge.flushSync).toHaveBeenCalled())
  })

  it('offers a reload when sync has stopped', () => {
    act(() => {
      useAppStore.setState({ syncStatus: 'dead' })
    })
    render(<SyncStatusIndicator />)

    fireEvent.click(screen.getByRole('button', { name: 'Sync status: Sync has stopped' }))

    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
  })
})
