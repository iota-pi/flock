import { act, fireEvent, render, screen } from '@testing-library/react'
import * as Sentry from '@sentry/react'
import { ReencryptionWaitError } from '@vault/client'
import MigrateApp, { POLL_INTERVAL_MS, REENCRYPT_WAIT_TIMEOUT_MS, STALL_TIMEOUT_MS } from './MigrateApp'
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
import { CLIENT_OUTDATED_WARNING } from '../app/vault/clientOutdated'
import { setClientOutdatedWarning } from './clientOutdatedWarning'
import * as migrationModule from './migration'
import * as usePasswordStrengthModule from '../hooks/usePasswordStrength'
import * as migrationBridgeModule from './migrationBridge'
import { spyOnExports } from '../utils/testUtils'

// The real check scores asynchronously with zxcvbn; these tests only need its verdict
const syncState = { status: 'idle', warning: null, fatalError: null }

async function logIn() {
  render(<MigrateApp />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'acc1' } })
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
      getSyncDiagnostics: vi.fn().mockResolvedValue(null),
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
    expect(startMigration).toHaveBeenCalledWith('acc1', 'password')
    expect(beginSync).toHaveBeenCalledWith('acc1')
    expect(screen.queryByLabelText(/^New password/i)).toBeNull()

    await poll()
    expect(screen.getByText(/Settings saved in the old format/)).toBeDefined()
    expect(finishMigration).not.toHaveBeenCalled()

    await poll()
    expect(finishMigration).toHaveBeenCalledWith('acc1')
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

      expect(changeToArgon2id).toHaveBeenCalledWith('acc1', 'a-much-better-password')
      expect(beginSync).toHaveBeenCalledWith('acc1')
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
    expect(reencryptOutdatedItems).toHaveBeenCalledWith('acc1', ['passwordDerivedDataKey'], expect.any(Function), expect.any(Object))
  })

  it('re-encrypts every item when snapshots are still unbound', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['unboundSnapshots'] })

    await logIn()
    await poll(3)

    expect(reencryptOutdatedItems).toHaveBeenCalledTimes(1)
    expect(reencryptOutdatedItems).toHaveBeenCalledWith('acc1', ['unboundSnapshots'], expect.any(Function), expect.any(Object))
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

    expect(isMigrationDeferred('acc1')).toBe(true)
    expect(finishMigration).toHaveBeenCalledWith('acc1')
  })

  it('does not offer to continue while the password still needs changing', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 3, account: 1, blockers: ['legacyKeyDerivation'] })

    await logIn()
    await poll(6)

    expect(screen.getByText(/could not be updated/)).toBeDefined()
    expect(screen.queryByRole('button', { name: /Continue to Flock/i })).toBeNull()
  })

  it('shows the warning when this page is out of date and can\'t reload itself', async () => {
    render(<MigrateApp />)

    act(() => setClientOutdatedWarning(CLIENT_OUTDATED_WARNING))

    expect(screen.getByText(CLIENT_OUTDATED_WARNING)).toBeDefined()
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

  describe('an update that stops moving', () => {
    const outdatedKey = { device: 3, account: 1, blockers: ['passwordDerivedDataKey'] }

    /** Re-encryption that waits until it's cancelled, as one stuck behind another tab would */
    function hangReencryption(stage: 'waitingForLeader' | 'waitingForSync' | null = null) {
      const signals: AbortSignal[] = []
      vi.mocked(reencryptOutdatedItems).mockImplementation((_account, _blockers, _onProgress, options) => {
        if (options?.signal) signals.push(options.signal)
        if (stage) options?.onStage?.(stage)
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')))
        })
      })
      return signals
    }

    async function waitPastStall() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + POLL_INTERVAL_MS)
      })
    }

    afterEach(() => {
      syncState.status = 'idle'
    })

    it('bounds the re-encryption waits, and says when another tab is in the way', async () => {
      vi.mocked(MigrationBridge.checkDataVersion).mockResolvedValue(outdatedKey)
      vi.mocked(reencryptOutdatedItems).mockImplementation(async (_account, _blockers, _onProgress, options) => {
        options?.onStage?.('waitingForLeader')
        throw new ReencryptionWaitError('waitingForLeader')
      })

      await logIn()
      await poll(2)

      expect(reencryptOutdatedItems).toHaveBeenCalledWith(
        'acc1',
        ['passwordDerivedDataKey'],
        expect.any(Function),
        expect.objectContaining({ waitTimeoutMs: REENCRYPT_WAIT_TIMEOUT_MS, signal: expect.any(AbortSignal) }),
      )
      expect(screen.getByText(/open in another tab or window/)).toBeDefined()
      expect(screen.getByText(/Still to update: Items still encrypted/)).toBeDefined()
    })

    it('shows what re-encryption is waiting on', async () => {
      vi.mocked(MigrationBridge.checkDataVersion).mockResolvedValue(outdatedKey)
      hangReencryption('waitingForSync')

      await logIn()
      await poll(2)

      expect(screen.getByText(/Waiting for your data to finish syncing/)).toBeDefined()
    })

    it('ends a re-encryption that never finishes, cancelling it', async () => {
      vi.mocked(MigrationBridge.checkDataVersion).mockResolvedValue(outdatedKey)
      const signals = hangReencryption()

      await logIn()
      await poll()
      await waitPastStall()

      expect(signals).toHaveLength(1)
      expect(signals[0].aborted).toBe(true)
      expect(screen.getByText(/could not finish syncing/)).toBeDefined()
      expect(screen.getByRole('button', { name: /Continue to Flock/i })).toBeDefined()
    })

    it('ends when sync never settles, which used to poll forever', async () => {
      syncState.status = 'error'
      vi.mocked(MigrationBridge.checkDataVersion).mockResolvedValue({ device: 2, account: 1, blockers: ['passwordDerivedDataKey'] })

      await logIn()
      await poll(10)
      expect(screen.getByText(/Keep this page open/)).toBeDefined()

      await waitPastStall()

      expect(reencryptOutdatedItems).not.toHaveBeenCalled()
      expect(screen.getByText(/could not finish syncing/)).toBeDefined()
    })

    it('ends when the server never answers', async () => {
      vi.mocked(MigrationBridge.checkDataVersion).mockRejectedValue(new Error('Failed to fetch'))

      await logIn()
      await waitPastStall()

      expect(screen.getByText(/could not reach the server/)).toBeDefined()
      // With nothing known about the account, there's nothing to say it can be left for later
      expect(screen.queryByRole('button', { name: /Continue to Flock/i })).toBeNull()
    })

    it('starts a new re-encryption on Try again, rather than joining the stuck one', async () => {
      vi.mocked(MigrationBridge.checkDataVersion).mockResolvedValue(outdatedKey)
      const signals = hangReencryption()

      await logIn()
      await poll()
      await waitPastStall()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
      })
      await poll()

      expect(reencryptOutdatedItems).toHaveBeenCalledTimes(2)
      expect(signals[1].aborted).toBe(false)
      expect(screen.getByText(/Keep this page open/)).toBeDefined()
    })

    it('reports why it stopped, with what the worker was waiting on', async () => {
      const captureMessage = vi.spyOn(Sentry, 'captureMessage')
      const diagnostics = {
        isLeader: false,
        isOnline: true,
        firstStartSynced: false,
        firstStartReadyToPush: false,
        firstStartError: 'The server refused item x',
        reencryptStage: 'waitingForLeader' as const,
      }
      vi.mocked(MigrationBridge.getSyncDiagnostics).mockResolvedValue(diagnostics)
      vi.mocked(MigrationBridge.checkDataVersion).mockResolvedValue(outdatedKey)
      vi.mocked(reencryptOutdatedItems).mockRejectedValue(new ReencryptionWaitError('waitingForLeader'))

      await logIn()
      await poll(2)

      expect(captureMessage).toHaveBeenCalledWith('Migration blocked', {
        extra: expect.objectContaining({ reason: 'anotherTab', blockers: ['passwordDerivedDataKey'], diagnostics }),
      })
    })
  })
})
