import { act, render, screen, fireEvent } from '@testing-library/react'
import AppUpdateSnackbar from './AppUpdateSnackbar'
import { useAppStore } from '../state/store'
import * as appUpdate from '../app/appUpdate'

vi.mock('../app/appUpdate', () => ({
  requestAppUpdate: vi.fn(),
}))

describe('AppUpdateSnackbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({
        appUpdateReady: false,
      })
    })
  })

  it('does not display message when appUpdateReady is false', () => {
    render(<AppUpdateSnackbar />)
    expect(screen.queryByText(/A new version of Flock is ready/i)).toBeNull()
  })

  it('displays message and reload button when appUpdateReady is true', () => {
    act(() => {
      useAppStore.setState({
        appUpdateReady: true,
      })
    })

    render(<AppUpdateSnackbar />)
    expect(screen.getByText(/A new version of Flock is ready/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /reload/i })).toBeDefined()
  })

  it('calls requestAppUpdate when Reload is clicked', () => {
    act(() => {
      useAppStore.setState({
        appUpdateReady: true,
      })
    })

    render(<AppUpdateSnackbar />)
    fireEvent.click(screen.getByRole('button', { name: /reload/i }))
    expect(appUpdate.requestAppUpdate).toHaveBeenCalledTimes(1)
  })
})
