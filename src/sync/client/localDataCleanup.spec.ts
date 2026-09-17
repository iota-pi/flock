import { clearAccountLocalData } from './localDataCleanup'
import * as syncMetadataStorage from '../worker/stores/syncMetadataStorage'
import { SyncWriteAheadLog } from '../worker/SyncWriteAheadLog'
import * as vaultPersistence from '../shared/VaultPersistence'
import * as manualRecoveryStore from '../shared/manualRecoveryStore'

vi.mock('../worker/stores/syncMetadataStorage', () => ({
  clearSyncMetadataStorage: vi.fn().mockResolvedValue(undefined),
  clearLegacySyncDatabases: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../worker/SyncWriteAheadLog', () => ({
  SyncWriteAheadLog: {
    clear: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../shared/VaultPersistence', () => ({
  clearSyncBatch: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../shared/manualRecoveryStore', () => ({
  clearManualRecoveryEntries: vi.fn().mockResolvedValue(undefined),
}))

describe('localDataCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing if accountId is empty', async () => {
    await clearAccountLocalData('')

    expect(syncMetadataStorage.clearSyncMetadataStorage).not.toHaveBeenCalled()
    expect(syncMetadataStorage.clearLegacySyncDatabases).not.toHaveBeenCalled()
    expect(SyncWriteAheadLog.clear).not.toHaveBeenCalled()
  })

  it('calls clearSyncMetadataStorage and clearLegacySyncDatabases for the account', async () => {
    await clearAccountLocalData('test-account')

    expect(syncMetadataStorage.clearSyncMetadataStorage).toHaveBeenCalledWith('test-account')
    expect(syncMetadataStorage.clearLegacySyncDatabases).toHaveBeenCalledWith('test-account')
    expect(SyncWriteAheadLog.clear).toHaveBeenCalledWith('test-account')
    expect(vaultPersistence.clearSyncBatch).toHaveBeenCalledWith('test-account')
    expect(manualRecoveryStore.clearManualRecoveryEntries).toHaveBeenCalledWith('test-account')
  })
})
