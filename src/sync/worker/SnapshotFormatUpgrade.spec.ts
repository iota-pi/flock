import { SnapshotFormatUpgrade } from './SnapshotFormatUpgrade'
import { SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'

const storage = new Map<string, unknown>()
vi.mock('./stores/syncMetadataStorage', async importOriginal => ({
  ...(await importOriginal<typeof import('./stores/syncMetadataStorage')>()),
  getSyncMetadataStorage: () => ({
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: unknown) => {
      storage.set(key, value)
      return value
    },
  }),
}))

function createUpgrade(result: { failed: unknown[] } = { failed: [] }) {
  const rewriteSnapshots = vi.fn<(signal: AbortSignal) => Promise<{ failed: unknown[] }>>()
    .mockResolvedValue(result)
  const onUpgraded = vi.fn()
  const upgrade = new SnapshotFormatUpgrade({ accountId: 'acct', rewriteSnapshots, onUpgraded })
  return { upgrade, rewriteSnapshots, onUpgraded }
}

describe('SnapshotFormatUpgrade', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('rewrites every snapshot once synced as leader, and records that it is done', async () => {
    const { upgrade, rewriteSnapshots, onUpgraded } = createUpgrade()

    upgrade.onSyncedWithoutFailures()
    expect(rewriteSnapshots).not.toHaveBeenCalled()
    upgrade.onLeaderChange(true)

    await vi.waitFor(() => expect(onUpgraded).toHaveBeenCalledTimes(1))
    expect(storage.get(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND)).toBe(true)
    expect(rewriteSnapshots).toHaveBeenCalledTimes(1)
  })

  it('waits for a sync without failures when leadership comes first', async () => {
    const { upgrade, rewriteSnapshots } = createUpgrade()

    upgrade.onLeaderChange(true)
    await Promise.resolve()
    expect(rewriteSnapshots).not.toHaveBeenCalled()
    upgrade.onSyncedWithoutFailures()

    await vi.waitFor(() => expect(rewriteSnapshots).toHaveBeenCalledTimes(1))
  })

  it('does not start in a tab that lost leadership', async () => {
    const { upgrade, rewriteSnapshots } = createUpgrade()

    upgrade.onLeaderChange(true)
    upgrade.onLeaderChange(false)
    upgrade.onSyncedWithoutFailures()
    await Promise.resolve()

    expect(rewriteSnapshots).not.toHaveBeenCalled()
  })

  it('skips a device that has already rewritten its snapshots', async () => {
    storage.set(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND, true)
    const { upgrade, rewriteSnapshots, onUpgraded } = createUpgrade()

    upgrade.onSyncedWithoutFailures()
    upgrade.onLeaderChange(true)

    await vi.waitFor(() => expect(onUpgraded).toHaveBeenCalledTimes(1))
    expect(rewriteSnapshots).not.toHaveBeenCalled()
  })

  it('runs at most once per session', async () => {
    const { upgrade, rewriteSnapshots } = createUpgrade()

    upgrade.onSyncedWithoutFailures()
    upgrade.onLeaderChange(true)
    upgrade.onSyncedWithoutFailures()
    upgrade.onLeaderChange(false)
    upgrade.onLeaderChange(true)

    await vi.waitFor(() => expect(storage.get(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND)).toBe(true))
    expect(rewriteSnapshots).toHaveBeenCalledTimes(1)
  })

  it('leaves an incomplete rewrite for the next session', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { upgrade, rewriteSnapshots, onUpgraded } = createUpgrade({ failed: [{ itemId: 'item-1', error: 'boom' }] })

    upgrade.onSyncedWithoutFailures()
    upgrade.onLeaderChange(true)
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 snapshots were not rewritten')))
    upgrade.onSyncedWithoutFailures()

    expect(rewriteSnapshots).toHaveBeenCalledTimes(1)
    expect(storage.has(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND)).toBe(false)
    expect(onUpgraded).not.toHaveBeenCalled()

    const next = createUpgrade()
    next.upgrade.onSyncedWithoutFailures()
    next.upgrade.onLeaderChange(true)
    await vi.waitFor(() => expect(next.rewriteSnapshots).toHaveBeenCalledTimes(1))
    warnSpy.mockRestore()
  })

  it('does not record completion after it was stopped', async () => {
    let finishRewrite!: () => void
    const { upgrade, rewriteSnapshots } = createUpgrade()
    rewriteSnapshots.mockImplementation(() => new Promise(resolve => {
      finishRewrite = () => resolve({ failed: [] })
    }))

    upgrade.onSyncedWithoutFailures()
    upgrade.onLeaderChange(true)
    await vi.waitFor(() => expect(rewriteSnapshots).toHaveBeenCalled())
    upgrade.stop()
    expect(rewriteSnapshots.mock.calls[0][0].aborted).toBe(true)
    finishRewrite()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(storage.has(SYNC_METADATA_KEYS.SNAPSHOTS_DOC_BOUND)).toBe(false)
  })
})
