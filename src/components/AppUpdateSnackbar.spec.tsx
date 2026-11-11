import { act, render, screen, fireEvent } from '@testing-library/react'
import AppUpdateSnackbar from './AppUpdateSnackbar'
import { useAppStore } from '../state/store'
import * as appUpdate from '../app/appUpdate'
import { spyOnExports } from '../utils/testUtils'

beforeEach(() => {
  spyOnExports(appUpdate, {
    requestAppUpdate: vi.fn(),
  })
})

describe('AppUpdateSnackbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({
        appUpdateReady: false,
        appUpdateDismissed: false,
        loggedIn: false,
      })
    })
  })

  afterEach(() => {
    act(() => {
      useAppStore.setState({ appUpdateReady: false, appUpdateDismissed: false, loggedIn: false })
    })
  })

  function showUpdate(loggedIn = false) {
    act(() => {
      useAppStore.getState().setAppUpdateReady(true)
      useAppStore.setState({ loggedIn })
    })
    render(<AppUpdateSnackbar />)
  }

  it('does not display message when appUpdateReady is false', () => {
    render(<AppUpdateSnackbar />)
    expect(screen.queryByText(/A new version of Flock is ready/i)).toBeNull()
  })

  it('offers the update on the lock screen', () => {
    showUpdate()
    expect(screen.getByText('A new version of Flock is ready.')).toBeDefined()
    expect(screen.getByRole('button', { name: /^update$/i })).toBeDefined()
  })

  it('says that updating locks a logged-in app', () => {
    showUpdate(true)
    expect(screen.getByText(/Updating will lock Flock/i)).toBeDefined()
  })

  it('calls requestAppUpdate when Update is clicked', () => {
    showUpdate(true)
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }))
    expect(appUpdate.requestAppUpdate).toHaveBeenCalledTimes(1)
  })

  it('hides until the next version once put off', () => {
    showUpdate(true)
    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    expect(appUpdate.requestAppUpdate).not.toHaveBeenCalled()
    expect(useAppStore.getState().appUpdateDismissed).toBe(true)
    expect(useAppStore.getState().appUpdateReady).toBe(true)

    act(() => {
      useAppStore.getState().setAppUpdateReady(true)
    })
    expect(useAppStore.getState().appUpdateDismissed).toBe(false)
  })
})
