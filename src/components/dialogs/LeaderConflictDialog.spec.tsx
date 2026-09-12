import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import LeaderConflictDialog from './LeaderConflictDialog'
import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../sync/client/SyncBridge'

vi.mock('../../sync/client/SyncBridge', () => ({
  SyncBridge: {
    claimLeader: vi.fn().mockResolvedValue(undefined),
  },
}))

describe('LeaderConflictDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({
        isLeaderConflict: false,
      })
    })
  })

  it('does not render dialog content when isLeaderConflict is false', () => {
    render(<LeaderConflictDialog />)
    expect(screen.queryByText(/Flock is syncing in another tab/i)).toBeNull()
  })

  it('renders dialog when isLeaderConflict is true', () => {
    act(() => {
      useAppStore.setState({ isLeaderConflict: true })
    })

    render(<LeaderConflictDialog />)

    expect(screen.getByText(/Flock is syncing in another tab/i)).toBeDefined()
    expect(screen.getByText(/Syncing is paused in this tab to prevent data conflicts/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /sync in this tab/i })).toBeDefined()
  })

  it('calls SyncBridge.claimLeader when "Sync in this tab" button is clicked', async () => {
    act(() => {
      useAppStore.setState({ isLeaderConflict: true })
    })

    render(<LeaderConflictDialog />)
    const claimButton = screen.getByRole('button', { name: /sync in this tab/i })

    fireEvent.click(claimButton)

    await waitFor(() => {
      expect(SyncBridge.claimLeader).toHaveBeenCalledTimes(1)
    })
  })
})
