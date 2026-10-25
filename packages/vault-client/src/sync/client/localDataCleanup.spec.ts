import { clearAccountLocalData } from './localDataCleanup'
import * as syncMetadataStorage from '../worker/stores/syncMetadataStorage'
import * as writeAheadLogStorage from '../shared/writeAheadLogStorage'
import * as manualRecoveryStore from '../shared/manualRecoveryStore'

vi.mock('../worker/stores/syncMetadataStorage', () => ({
  clearSyncMetadataStorage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../shared/writeAheadLogStorage', () => ({
  clearWriteAheadLog: vi.fn().mockResolvedValue(undefined),
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
    expect(writeAheadLogStorage.clearWriteAheadLog).not.toHaveBeenCalled()
  })

  it('clears sync metadata, the WAL and manual recovery entries for the account', async () => {
    await clearAccountLocalData('test-account')

    expect(syncMetadataStorage.clearSyncMetadataStorage).toHaveBeenCalledWith('test-account')
    expect(writeAheadLogStorage.clearWriteAheadLog).toHaveBeenCalledWith('test-account')
    expect(manualRecoveryStore.clearManualRecoveryEntries).toHaveBeenCalledWith('test-account')
  })
})
