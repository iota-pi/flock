import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { createMemoryRouter, RouterProvider } from 'react-router'
import LoginPage from './Login'
import getTheme from '../../theme'
import * as vault from '../../api/vault'
import { useAppStore } from '../../state/store'

const lightTheme = getTheme(false)

const renderLoginPage = () => {
  const router = createMemoryRouter([
    {
      path: '/login',
      element: <LoginPage />,
    },
    {
      path: '/',
      element: <div>Dashboard</div>,
    },
  ], { initialEntries: ['/login'] })

  return render(
    <ThemeProvider theme={lightTheme}>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    useAppStore.setState({ account: '', loggedIn: false, justCreatedAccount: false })
  })

  it('renders login form with account and password inputs', () => {
    renderLoginPage()
    expect(screen.getByLabelText(/Account ID/i)).toBeDefined()
    expect(screen.getByLabelText(/Password/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /Login/i })).toBeDefined()
  })

  it('falls back to cached security params when getSecurityParams fails (offline)', async () => {
    // Seed cached metadata
    localStorage.setItem('FlockVaultMeta', JSON.stringify({
      account: 'test-offline-account',
      salt: 'cached-salt',
      iterations: 5000,
      saltVersion: 1,
    }))

    vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(new Error('Network offline'))
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(undefined)

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'test-offline-account' } })
      fireEvent.change(passwordInput, { target: { value: 'secret123' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(loginVaultSpy).toHaveBeenCalledWith({
        account: 'test-offline-account',
        password: 'secret123',
        salt: 'cached-salt',
        iterations: 5000,
        saltVersion: 1,
      })
      expect(useAppStore.getState().loggedIn).toBe(true)
    })
  })

  it('displays error if getSecurityParams fails and no cached metadata is present', async () => {
    vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(new Error('Network offline'))
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(undefined)

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'unknown-account' } })
      fireEvent.change(passwordInput, { target: { value: 'secret123' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(loginVaultSpy).not.toHaveBeenCalled()
      expect(screen.getByText(/Could not find matching account ID and password/i)).toBeDefined()
    })
  })

  it('displays incorrect password error and does not show server failure message', async () => {
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({
      salt: 'test-salt',
      iterations: 5000,
      saltVersion: 1,
    })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(new Error('Incorrect password. Please try again.'))

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'my-account' } })
      fireEvent.change(passwordInput, { target: { value: 'wrong-pass' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
      expect(screen.getByText(/Incorrect password\. Please try again\./i)).toBeDefined()
      expect(useAppStore.getState().message).toBeNull()
    })
  })

  it('allows dismissing error alert with close button', async () => {
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({
      salt: 'test-salt',
      iterations: 5000,
      saltVersion: 1,
    })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(new Error('Incorrect password. Please try again.'))

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'my-account' } })
      fireEvent.change(passwordInput, { target: { value: 'wrong-pass' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })

    const closeButton = screen.getByRole('button', { name: /close/i })
    await act(async () => {
      fireEvent.click(closeButton)
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears error alert when typing in input fields', async () => {
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({
      salt: 'test-salt',
      iterations: 5000,
      saltVersion: 1,
    })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(new Error('Incorrect password. Please try again.'))

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'my-account' } })
      fireEvent.change(passwordInput, { target: { value: 'wrong-pass' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
    })

    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: 'wrong-pass-2' } })
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
