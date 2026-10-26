import { act, fireEvent, render, screen } from '@testing-library/react'
import MigrateApp, { POLL_INTERVAL_MS } from './MigrateApp'
import {
  beginSync,
  changeToArgon2id,
  finishMigration,
  OfflineError,
  reencryptOutdatedItems,
  startMigration,
} from './migration'
import { MigrationBridge } from './migrationBridge'
import { isMigrationDeferred } from './detection'
import * as migrationModule from './migration'
import * as usePasswordStrengthModule from '../hooks/usePasswordStrength'
import * as migrationBridgeModule from './migrationBridge'
import { spyOnExports } from '../utils/testUtils'

// The real check scores asynchronously with zxcvbn; these tests only need its verdict
const syncState = { status: 'idle', warning: null, fatalError: null }

async function logIn() {
  render(<MigrateApp />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'acct-1' } })
    fireEvent.change(screen.getByLabelText(/^Password/i), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: /Update my data/i }))
  })
}

async function poll(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
  }
}

async function enterNewPassword(password: string, confirmation = password, consent = true) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/^New password/i), { target: { value: password } })
    fireEvent.change(screen.getByLabelText(/Confirm new password/i), { target: { value: confirmation } })
    if (consent) {
      fireEvent.click(screen.getByRole('checkbox'))
    }
  })
}

function changePasswordButton() {
  return screen.getByRole('button', { name: /Change password and continue/i }) as HTMLButtonElement
}

beforeEach(() => {
  spyOnExports(migrationModule, {
    startMigration: vi.fn(),
    changeToArgon2id: vi.fn(),
    beginSync: vi.fn(),
    reencryptOutdatedItems: vi.fn(),
    finishMigration: vi.fn(),
  })
  spyOnExports(usePasswordStrengthModule, {
    usePasswordStrength: (password: string) => (password === 'weak'
      ? { score: 1, error: 'Please choose a stronger password' }
      : { score: password ? 4 : 0, error: '' }),
  })
  spyOnExports(migrationBridgeModule, {
    MigrationBridge: {
      checkDataVersion: vi.fn(),
      fullResync: vi.fn().mockResolvedValue(true),
    },
    subscribeSyncState: () => () => {},
    getSyncState: () => syncState,
  })
})

describe('MigrateApp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    sessionStorage.clear()
    vi.mocked(startMigration).mockReset().mockResolvedValue({ needsNewPassword: false })
    vi.mocked(changeToArgon2id).mockReset().mockResolvedValue(undefined)
    vi.mocked(beginSync).mockReset().mockResolvedValue(undefined)
    vi.mocked(reencryptOutdatedItems).mockReset().mockResolvedValue({ failed: [] })
    vi.mocked(finishMigration).mockReset().mockResolvedValue(undefined)
    vi.mocked(MigrationBridge.checkDataVersion).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('prefills the account the main app handed over', () => {
    sessionStorage.setItem('flock-migration-account', 'handed-over')
    render(<MigrateApp />)
    expect(screen.getByLabelText(/Account ID/i)).toHaveProperty('value', 'handed-over')
  })

  it('migrates, then returns to the main app once both levels are current', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValueOnce({ device: 0, account: 1, blockers: ['legacySettings'] })
      .mockResolvedValue({ device: 3, account: 3, blockers: [] })

    await logIn()
    expect(startMigration).toHaveBeenCalledWith('acct-1', 'password')
    expect(beginSync).toHaveBeenCalledWith('acct-1')
    expect(screen.queryByLabelText(/^New password/i)).toBeNull()

    await poll()
    expect(screen.getByText(/Settings saved in the old format/)).toBeDefined()
    expect(finishMigration).not.toHaveBeenCalled()

    await poll()
    expect(finishMigration).toHaveBeenCalledWith('acct-1')
  })

  it('asks to go online when the server is unreachable', async () => {
    vi.mocked(startMigration).mockRejectedValue(new OfflineError())

    await logIn()

    expect(screen.getByText(/Connect to the internet/)).toBeDefined()
    expect(screen.getByRole('button', { name: /Update my data/i })).toBeDefined()
  })

  describe('new password', () => {
    beforeEach(() => {
      vi.mocked(startMigration).mockResolvedValue({ needsNewPassword: true })
    })

    it('asks for a new password before syncing, then changes it and starts sync', async () => {
      await logIn()
      expect(beginSync).not.toHaveBeenCalled()

      await enterNewPassword('a-much-better-password')
      expect(changePasswordButton().disabled).toBe(false)
      await act(async () => {
        fireEvent.click(changePasswordButton())
      })

      expect(changeToArgon2id).toHaveBeenCalledWith('acct-1', 'a-much-better-password')
      expect(beginSync).toHaveBeenCalledWith('acct-1')
      expect(screen.getByText(/Keep this page open/)).toBeDefined()
    })

    it('refuses the password the user logged in with', async () => {
      await logIn()
      await enterNewPassword('password')

      expect(screen.getByText(/not used for Flock before/)).toBeDefined()
      expect(changePasswordButton().disabled).toBe(true)
    })

    it('refuses a weak password', async () => {
      await logIn()
      await enterNewPassword('weak')

      expect(screen.getByText(/choose a stronger password/)).toBeDefined()
      expect(changePasswordButton().disabled).toBe(true)
    })

    it('needs a matching confirmation and the user\'s consent', async () => {
      await logIn()
      await enterNewPassword('a-much-better-password', 'a-much-better-passw0rd', false)
      expect(screen.getByText(/do not match/)).toBeDefined()
      expect(changePasswordButton().disabled).toBe(true)

      await enterNewPassword('a-much-better-password', 'a-much-better-password', false)
      expect(changePasswordButton().disabled).toBe(true)

      await act(async () => {
        fireEvent.click(screen.getByRole('checkbox'))
      })
      expect(changePasswordButton().disabled).toBe(false)
    })

    it('only retries starting sync, never the password change, when sync fails to start', async () => {
      vi.mocked(beginSync).mockRejectedValueOnce(new Error('Sync worker failed to start'))
      await logIn()
      await enterNewPassword('a-much-better-password')
      await act(async () => {
        fireEvent.click(changePasswordButton())
      })

      expect(changeToArgon2id).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/Your password has been changed/)).toBeDefined()
      expect(screen.queryByLabelText(/^New password/i)).toBeNull()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
      })

      expect(changeToArgon2id).toHaveBeenCalledTimes(1)
      expect(beginSync).toHaveBeenCalledTimes(2)
      expect(screen.getByText(/Keep this page open/)).toBeDefined()
    })

    it('stays on the form when changing the password fails', async () => {
      vi.mocked(changeToArgon2id).mockRejectedValue(new Error('CONFLICT'))
      await logIn()
      await enterNewPassword('a-much-better-password')
      await act(async () => {
        fireEvent.click(changePasswordButton())
      })

      expect(screen.getByText('CONFLICT')).toBeDefined()
      expect(beginSync).not.toHaveBeenCalled()
      expect(screen.getByLabelText(/^New password/i)).toBeDefined()
    })
  })

  it('re-encrypts data still under the password-derived key once sync has settled, only once', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['passwordDerivedDataKey'] })

    await logIn()
    await poll(3)

    expect(reencryptOutdatedItems).toHaveBeenCalledTimes(1)
    expect(reencryptOutdatedItems).toHaveBeenCalledWith('acct-1', ['passwordDerivedDataKey'], expect.any(Function))
  })

  it('re-encrypts every item when snapshots are still unbound', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['unboundSnapshots'] })

    await logIn()
    await poll(3)

    expect(reencryptOutdatedItems).toHaveBeenCalledTimes(1)
    expect(reencryptOutdatedItems).toHaveBeenCalledWith('acct-1', ['unboundSnapshots'], expect.any(Function))
  })

  it("doesn't re-encrypt for blockers re-encryption can't clear", async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['legacyCipherItems'] })

    await logIn()
    await poll(3)

    expect(reencryptOutdatedItems).not.toHaveBeenCalled()
  })

  it('shows what could not be migrated, and lets the user continue for now', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['legacyCipherItems'] })

    await logIn()
    await poll(6)

    expect(screen.getByText(/could not be updated: Items saved in the old format/)).toBeDefined()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue to Flock/i }))
    })

    expect(isMigrationDeferred('acct-1')).toBe(true)
    expect(finishMigration).toHaveBeenCalledWith('acct-1')
  })

  it('does not offer to continue while the password still needs changing', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['legacyKeyDerivation'] })

    await logIn()
    await poll(6)

    expect(screen.getByText(/could not be updated/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Continue to Flock/i })).toBeNull()
  })

  it('retries with a full resync', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['legacyCipherItems'] })

    await logIn()
    await poll(6)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
    })

    expect(MigrationBridge.fullResync).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Keep this page open/)).toBeDefined()
  })
})
