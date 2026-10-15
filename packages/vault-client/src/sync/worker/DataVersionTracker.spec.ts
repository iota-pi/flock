import { DataVersionTracker, readDeviceDataVersion } from './DataVersionTracker'
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

function createTracker(dataVersion = 2, blockers: string[] = []) {
  const raiseAccountDataVersion = vi.fn(async () => ({ dataVersion: blockers.length > 0 ? 1 : dataVersion, blockers }))
  const tracker = new DataVersionTracker({ accountId: 'acct', dataVersion, raiseAccountDataVersion })
  return { tracker, raiseAccountDataVersion }
}

describe('DataVersionTracker', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('reads an unrecorded device version as 0', async () => {
    await expect(readDeviceDataVersion('acct')).resolves.toBe(0)
  })

  it('starts a device with no local data at the current version', async () => {
    const { tracker } = createTracker()

    await tracker.onStart(false)

    await expect(readDeviceDataVersion('acct')).resolves.toBe(2)
  })

  it('waits for a sync without failures before recording a device with local data', async () => {
    const { tracker } = createTracker()

    await tracker.onStart(true)
    await expect(readDeviceDataVersion('acct')).resolves.toBe(0)

    await tracker.onSyncedWithoutFailures()
    await expect(readDeviceDataVersion('acct')).resolves.toBe(2)
  })

  it('never lowers the device version', async () => {
    storage.set(SYNC_METADATA_KEYS.DEVICE_DATA_VERSION, 3)
    const { tracker } = createTracker(2)

    await tracker.onSyncedWithoutFailures()

    await expect(readDeviceDataVersion('acct')).resolves.toBe(3)
  })

  it('asks the server to raise the account version once per session', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { tracker, raiseAccountDataVersion } = createTracker(2, ['unboundSnapshots'])

    await tracker.onSnapshotsUpgraded()
    await tracker.onSnapshotsUpgraded()

    expect(raiseAccountDataVersion).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('unboundSnapshots'))
    infoSpy.mockRestore()
  })

  it('does nothing for an app without a data version', async () => {
    const { tracker, raiseAccountDataVersion } = createTracker(0)

    await tracker.onStart(false)
    await tracker.onSyncedWithoutFailures()
    await tracker.onSnapshotsUpgraded()

    expect(storage.has(SYNC_METADATA_KEYS.DEVICE_DATA_VERSION)).toBe(false)
    expect(raiseAccountDataVersion).not.toHaveBeenCalled()
  })

  it('reports the device level and the account level the server raised it to', async () => {
    storage.set(SYNC_METADATA_KEYS.DEVICE_DATA_VERSION, 2)
    const { tracker, raiseAccountDataVersion } = createTracker(2, ['legacyCipherItems'])

    await expect(tracker.checkStatus()).resolves.toEqual({
      device: 2,
      account: 1,
      blockers: ['legacyCipherItems'],
    })
    expect(raiseAccountDataVersion).toHaveBeenCalledTimes(1)
  })
})
