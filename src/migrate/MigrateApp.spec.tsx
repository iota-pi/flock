import { act, fireEvent, render, screen } from '@testing-library/react'
import MigrateApp, { POLL_INTERVAL_MS } from './MigrateApp'
import { finishMigration, OfflineError, startMigration } from './migration'
import { MigrationBridge } from './migrationBridge'
import { isMigrationDeferred } from './detection'

vi.mock('./migration', async importOriginal => ({
  ...await importOriginal<typeof import('./migration')>(),
  startMigration: vi.fn(),
  finishMigration: vi.fn(),
}))

const syncState = vi.hoisted(() => ({ status: 'idle', warning: null, fatalError: null }))

vi.mock('./migrationBridge', () => ({
  MigrationBridge: {
    checkDataVersion: vi.fn(),
    fullResync: vi.fn().mockResolvedValue(true),
  },
  subscribeSyncState: () => () => {},
  getSyncState: () => syncState,
}))

async function logIn() {
  render(<MigrateApp />)
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/Account ID/i), { target: { value: 'acct-1' } })
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'password' } })
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

describe('MigrateApp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    sessionStorage.clear()
    vi.mocked(startMigration).mockReset().mockResolvedValue(undefined)
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
      .mockResolvedValueOnce({ device: 0, account: 0, blockers: ['legacySettings'] })
      .mockResolvedValue({ device: 1, account: 1, blockers: [] })

    await logIn()
    expect(startMigration).toHaveBeenCalledWith('acct-1', 'password')

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

  it('shows what could not be migrated, and lets the user continue for now', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 1, account: 0, blockers: ['legacyCipherItems'] })

    await logIn()
    await poll(6)

    expect(screen.getByText(/could not be updated: Items saved in the old format/)).toBeDefined()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Continue to Flock/i }))
    })

    expect(isMigrationDeferred('acct-1')).toBe(true)
    expect(finishMigration).toHaveBeenCalledWith('acct-1')
  })

  it('retries with a full resync', async () => {
    vi.mocked(MigrationBridge.checkDataVersion)
      .mockResolvedValue({ device: 1, account: 0, blockers: ['legacyCipherItems'] })

    await logIn()
    await poll(6)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Try again/i }))
    })

    expect(MigrationBridge.fullResync).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Keep this page open/)).toBeDefined()
  })
})
