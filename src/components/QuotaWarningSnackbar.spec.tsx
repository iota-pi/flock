import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import QuotaWarningSnackbar from './QuotaWarningSnackbar'
import { useAppStore } from '../state/store'

describe('QuotaWarningSnackbar', () => {
  const onOpenDetails = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({
        isQuotaExceeded: false,
      })
    })
  })

  it('does not display warning when isQuotaExceeded is false', () => {
    render(<QuotaWarningSnackbar onOpenDetails={onOpenDetails} />)
    expect(screen.queryByText(/Storage full/i)).toBeNull()
  })

  it('displays persistent warning when isQuotaExceeded is true', () => {
    act(() => {
      useAppStore.setState({
        isQuotaExceeded: true,
      })
    })

    render(<QuotaWarningSnackbar onOpenDetails={onOpenDetails} />)
    expect(screen.getByText(/Storage full: Changes are stored in memory only/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /more info/i })).toBeDefined()
  })

  it('triggers onOpenDetails when More Info is clicked', () => {
    act(() => {
      useAppStore.setState({
        isQuotaExceeded: true,
      })
    })

    render(<QuotaWarningSnackbar onOpenDetails={onOpenDetails} />)
    fireEvent.click(screen.getByRole('button', { name: /more info/i }))
    expect(onOpenDetails).toHaveBeenCalledTimes(1)
  })
})
