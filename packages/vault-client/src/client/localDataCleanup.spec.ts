import { clearAccountLocalData } from './localDataCleanup'
import * as syncMetadataStorage from '../shared/syncMetadataStorage'
import * as writeAheadLogStorage from '../shared/writeAheadLogStorage'
import * as manualRecoveryStore from '../shared/manualRecoveryStore'
import { spyOnExports } from '../../test/moduleMocks'

beforeEach(() => {
  spyOnExports(syncMetadataStorage, {
    clearSyncMetadataStorage: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(writeAheadLogStorage, {
    clearWriteAheadLog: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(manualRecoveryStore, {
    clearManualRecoveryEntries: vi.fn().mockResolvedValue(undefined),
  })
})

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

  describe('deleting the Automerge databases', () => {
    const originalIndexedDB = globalThis.indexedDB
    let mockReq: {
      onsuccess: ((event?: any) => void) | null
      onerror: ((event?: any) => void) | null
      onblocked: ((event?: any) => void) | null
      error?: Error | null
    }

    beforeEach(() => {
      mockReq = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        error: null,
      }
      globalThis.indexedDB = {
        deleteDatabase: vi.fn().mockImplementation(() => mockReq),
      } as any
    })

    afterEach(() => {
      globalThis.indexedDB = originalIndexedDB
      vi.useRealTimers()
    })

    it('catches rejection from deleteDatabase gracefully', async () => {
      vi.useFakeTimers()
      const clearPromise = clearAccountLocalData('acc-1')

      mockReq.onblocked?.()
      vi.advanceTimersByTime(5000)

      // A failed delete is logged rather than thrown
      await expect(clearPromise).resolves.toBeUndefined()
    })

    it('deletes both the plaintext and sealed Automerge databases', async () => {
      globalThis.indexedDB = {
        deleteDatabase: vi.fn().mockImplementation(() => {
          const req: typeof mockReq = { onsuccess: null, onerror: null, onblocked: null }
          setTimeout(() => req.onsuccess?.(), 0)
          return req
        }),
      } as any
      await clearAccountLocalData('acc-1')
      expect(globalThis.indexedDB.deleteDatabase).toHaveBeenCalledWith('test-vault-automerge-acc-1')
      expect(globalThis.indexedDB.deleteDatabase).toHaveBeenCalledWith('test-vault-automerge-sealed-acc-1')
    })
  })
})
