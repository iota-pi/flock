import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { createMemoryRouter, RouterProvider } from 'react-router'
import LoginPage from './Login'
import getTheme from '../../theme'
import * as vault from '@vault/client'
import { useAppStore } from '../../state/store'
import { goToMigration } from 'src/migrate/detection'
import * as detectionModule from 'src/migrate/detection'
import { spyOnExports } from '../../utils/testUtils'
import * as brokenBuild from 'src/app/brokenBuild'

const lightTheme = getTheme(false)
const NOT_UPGRADED = { keyDerivationUpgraded: false, biometricsCleared: false }
const ARGON2ID = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }

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

beforeEach(() => {
  spyOnExports(detectionModule, {
    goToMigration: vi.fn(),
  })
})

describe('LoginPage', () => {
  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({ account: '', loggedIn: false, justCreatedAccount: false })
  })

  afterEach(() => {
    vi.useRealTimers()
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
      account: 'abcd2345',
      salt: 'cached-salt',
      iterations: 5000,
      saltVersion: 1,
    }))

    vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(new Error('Network offline'))
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'abcd2345' } })
      fireEvent.change(passwordInput, { target: { value: 'secret123' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(loginVaultSpy).toHaveBeenCalledWith({
        account: 'abcd2345',
        password: 'secret123',
        salt: 'cached-salt',
        iterations: 5000,
        saltVersion: 1,
      })
      expect(useAppStore.getState().loggedIn).toBe(true)
    })
  })

  it("uses cached security params when the server is slow, rather than waiting for it", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true })
    localStorage.setItem('FlockVaultMeta', JSON.stringify({
      account: 'abcd3456',
      salt: 'cached-salt',
      iterations: 5000,
      saltVersion: 1,
    }))

    vi.spyOn(vault, 'getSecurityParams').mockReturnValue(new Promise(() => {}))
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'abcd3456' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'secret123' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })
    expect(loginVaultSpy).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    await waitFor(() => {
      expect(loginVaultSpy).toHaveBeenCalledWith(expect.objectContaining({ salt: 'cached-salt' }))
    })
  })

  it('asks for a connection, after retrying, if getSecurityParams fails and no cached metadata is present', async () => {
    const paramsSpy = vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(new Error('Network offline'))
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'abcd1234' } })
      fireEvent.change(passwordInput, { target: { value: 'secret123' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(loginVaultSpy).not.toHaveBeenCalled()
      expect(screen.getByText(/Could not reach the server/i)).toBeDefined()
    })
    expect(paramsSpy).toHaveBeenCalledWith('abcd1234', { retry: true })
    expect(screen.queryByText(/Could not find matching account ID/i)).toBeNull()
  })

  it('logs in with the canonical account ID however it was typed', async () => {
    const paramsSpy = vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: ' ABCD-I234 ' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'secret123' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })

    await waitFor(() => {
      expect(loginVaultSpy).toHaveBeenCalledWith(expect.objectContaining({ account: 'abcd1234' }))
    })
    expect(paramsSpy).toHaveBeenCalledWith('abcd1234', { retry: true })
    expect(useAppStore.getState().account).toBe('abcd1234')
  })

  it('explains a malformed account ID without asking the server', async () => {
    const paramsSpy = vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'abcd-123' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'secret123' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })

    expect(screen.getByText(/Account IDs have 8 characters/i)).toBeDefined()
    expect(paramsSpy).not.toHaveBeenCalled()
    expect(loginVaultSpy).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'abcd-1234' } })
    })
    expect(screen.queryByText(/Account IDs have 8 characters/i)).toBeNull()
  })

  it('shows a stored account ID with its hyphen', () => {
    localStorage.setItem('FlockVaultMeta', JSON.stringify({ account: 'abcd1234', salt: 'cached-salt' }))

    renderLoginPage()

    expect(screen.getByDisplayValue('abcd-1234')).toBeDefined()
  })

  it('says the account was not found only when the server says so', async () => {
    const notFound = Object.assign(new Error('Account not found'), { data: { code: 'NOT_FOUND', httpStatus: 404 } })
    vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(notFound)
    const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'zzzz9999' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'secret123' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })

    await waitFor(() => {
      expect(loginVaultSpy).not.toHaveBeenCalled()
      expect(screen.getByText(/Could not find matching account ID and password/i)).toBeDefined()
    })
  })

  it('tells the user to wait when the server refuses logins to the account', async () => {
    const error = Object.assign(new Error('TOO_MANY_REQUESTS'), { data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 } })
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(error)

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'abcd1234' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'secret123' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })

    await waitFor(() => {
      expect(screen.getByText(/Too many login attempts/i)).toBeDefined()
    })
  })

  it('updates the app, rather than failing, when part of it fails to load', async () => {
    const recover = vi.spyOn(brokenBuild, 'recoverFromChunkLoadError').mockResolvedValue()
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(
      new TypeError('Failed to fetch dynamically imported module: https://flock.example/assets/index.esm-abc.js'),
    )

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'abcd1234' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'secret123' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })

    await waitFor(() => {
      expect(screen.getByText(/Part of Flock failed to load/i)).toBeDefined()
    })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/dynamically imported module/i)).toBeNull()
  })

  it('displays incorrect password error and does not show server failure message', async () => {
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({
      salt: 'test-salt',
      saltVersion: 1,
      kdf: ARGON2ID,
      dataVersion: 2,
    })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(new Error('Incorrect account ID or password. Please try again.'))

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'abcd1234' } })
      fireEvent.change(passwordInput, { target: { value: 'wrong-pass' } })
      fireEvent.click(loginButton)
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined()
      expect(screen.getByText(/Incorrect account ID or password\. Please try again\./i)).toBeDefined()
      expect(useAppStore.getState().message).toBeNull()
    })
  })

  it('allows dismissing error alert with close button', async () => {
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({
      salt: 'test-salt',
      saltVersion: 1,
      kdf: ARGON2ID,
      dataVersion: 2,
    })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(new Error('Incorrect account ID or password. Please try again.'))

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'abcd1234' } })
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
      saltVersion: 1,
      kdf: ARGON2ID,
      dataVersion: 2,
    })
    vi.spyOn(vault, 'loginVault').mockRejectedValue(new Error('Incorrect account ID or password. Please try again.'))

    renderLoginPage()

    const accountInput = screen.getByLabelText(/Account ID/i)
    const passwordInput = screen.getByLabelText(/Password/i)
    const loginButton = screen.getByRole('button', { name: /Login/i })

    await act(async () => {
      fireEvent.change(accountInput, { target: { value: 'abcd1234' } })
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

  it('tells the user when logging in upgraded their account encryption', async () => {
    useAppStore.setState({ message: null })
    vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })
    vi.spyOn(vault, 'loginVault').mockResolvedValue({ keyDerivationUpgraded: true, biometricsCleared: true })

    renderLoginPage()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'abcd1234' } })
      fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'pass' } })
      fireEvent.click(screen.getByRole('button', { name: /Login/i }))
    })

    await waitFor(() => {
      expect(useAppStore.getState().loggedIn).toBe(true)
      const message = useAppStore.getState().message
      expect(message?.severity).toBe('info')
      expect(message?.message).toMatch(/other devices will ask you to log in again/)
      expect(message?.message).toMatch(/unlock was turned off on this device/)
    })
  })

  it('asks for the password when the biometric key is stale', async () => {
    vi.spyOn(vault, 'hasBiometricData').mockReturnValue(true)
    vi.spyOn(vault, 'readBiometricData').mockReturnValue({
      account: 'abcd1234',
      credentialId: 'cred',
      prfSalt: 'salt',
      encryptedMasterKey: { iv: '', cipher: '' },
    })
    const unlockSpy = vi.spyOn(vault, 'unlockWithBiometrics').mockRejectedValue(new vault.StaleBiometricKeyError())

    renderLoginPage()

    await waitFor(() => {
      expect(unlockSpy).toHaveBeenCalledWith('abcd1234')
      expect(screen.getByText(/changed on another device/i)).toBeDefined()
      expect(screen.getByLabelText(/Password/i)).toBeDefined()
    })
    expect(useAppStore.getState().loggedIn).toBe(false)
  })

  describe('migration', () => {
    async function logIn() {
      renderLoginPage()
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'old1' } })
        fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'password' } })
        fireEvent.click(screen.getByRole('button', { name: /Login/i }))
      })
    }

    beforeEach(() => {
      vi.mocked(goToMigration).mockClear()
    })

    it('sends an account below the minimum level to the migration app before deriving keys', async () => {
      vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, dataVersion: 0 })
      const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

      await logIn()

      await waitFor(() => expect(goToMigration).toHaveBeenCalledWith('old1'))
      expect(loginVaultSpy).not.toHaveBeenCalled()
    })

    it('lets an account whose migration was deferred log in', async () => {
      localStorage.setItem('flock-migration-deferred', JSON.stringify({ 'old1': Date.now() + 60_000 }))
      vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 1 })
      const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

      await logIn()

      await waitFor(() => expect(loginVaultSpy).toHaveBeenCalled())
      expect(goToMigration).not.toHaveBeenCalled()
    })

    it('sends an account the server describes as PBKDF2 to the migration app, whatever its level', async () => {
      localStorage.setItem('flock-migration-deferred', JSON.stringify({ 'old1': Date.now() + 60_000 }))
      vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, iterations: 600_000, dataVersion: 2 })
      const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

      await logIn()

      await waitFor(() => expect(goToMigration).toHaveBeenCalledWith('old1'))
      expect(loginVaultSpy).not.toHaveBeenCalled()
    })

    it('logs in with Argon2id parameters cached on the device when offline', async () => {
      localStorage.setItem('FlockVaultMeta', JSON.stringify({ account: 'old1', salt: 'cached-salt', saltVersion: 1, kdf: ARGON2ID }))
      vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(new Error('Network offline'))
      const loginVaultSpy = vi.spyOn(vault, 'loginVault').mockResolvedValue(NOT_UPGRADED)

      await logIn()

      await waitFor(() => expect(loginVaultSpy).toHaveBeenCalledWith(expect.objectContaining({ salt: 'cached-salt', kdf: ARGON2ID })))
      expect(goToMigration).not.toHaveBeenCalled()
    })

    it('sends key derivation parameters this app no longer accepts to the migration app', async () => {
      vi.spyOn(vault, 'getSecurityParams').mockResolvedValue({ salt: 'test-salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })
      vi.spyOn(vault, 'loginVault').mockRejectedValue(new vault.UnsupportedKeyDerivationError(0))

      await logIn()

      await waitFor(() => expect(goToMigration).toHaveBeenCalledWith('old1'))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('asks for a connection when PBKDF2 parameters cached on the device can only be used by the migration app', async () => {
      localStorage.setItem('FlockVaultMeta', JSON.stringify({ account: 'old1', salt: 'cached-salt', iterations: 600000 }))
      vi.spyOn(vault, 'getSecurityParams').mockRejectedValue(new Error('Network offline'))
      // The main app no longer derives PBKDF2 keys
      vi.spyOn(vault, 'loginVault').mockRejectedValue(new vault.UnsupportedKeyDerivationError('This app no longer derives PBKDF2 keys'))

      await logIn()

      expect(await screen.findByText(/need updating, which needs a connection to the server/)).toBeDefined()
      expect(goToMigration).not.toHaveBeenCalled()
    })
  })
})
