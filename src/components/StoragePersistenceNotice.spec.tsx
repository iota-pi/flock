import { act, fireEvent, render, screen } from '@testing-library/react'
import StoragePersistenceNotice from './StoragePersistenceNotice'
import { useAppStore } from '../state/store'

describe('StoragePersistenceNotice', () => {
  function setState(isStoragePersisted: boolean | null, pendingItems = 0) {
    act(() => {
      useAppStore.setState({
        isStoragePersisted,
        syncProgress: { pendingItems, quarantinedItems: 0, lastSyncedAt: null },
      })
    })
  }

  function stubStandalone(matches: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query === '(display-mode: standalone)' }))
  }

  beforeEach(() => {
    stubStandalone(false)
    setState(null)
  })

  it('shows nothing until the browser has answered, or when storage is persisted', () => {
    const { rerender } = render(<StoragePersistenceNotice />)
    expect(screen.queryByRole('alert')).toBeNull()

    setState(true, 3)
    rerender(<StoragePersistenceNotice />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows nothing when the app is installed', () => {
    stubStandalone(true)
    setState(false, 3)
    render(<StoragePersistenceNotice />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('suggests installing when storage is not persisted', () => {
    setState(false)
    render(<StoragePersistenceNotice />)
    expect(screen.getByRole('alert').textContent).toMatch(/may clear Flock's data.*Add to Home Screen/)
  })

  it('warns about unsynced changes', () => {
    setState(false, 2)
    render(<StoragePersistenceNotice />)
    expect(screen.getByText(/Unsynced changes could be lost/)).toBeDefined()
  })

  it('remembers a dismissed notice, but warns again when there are unsynced changes', () => {
    setState(false)
    const { unmount } = render(<StoragePersistenceNotice />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByRole('alert')).toBeNull()
    unmount()

    const { rerender } = render(<StoragePersistenceNotice />)
    expect(screen.queryByRole('alert')).toBeNull()

    setState(false, 1)
    rerender(<StoragePersistenceNotice />)
    expect(screen.getByText(/Unsynced changes could be lost/)).toBeDefined()
  })
})
