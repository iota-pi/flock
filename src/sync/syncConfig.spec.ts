import { describe, it, expect } from 'vitest'
import { SYNC_TIMEOUTS, SYNC_BATCH_SIZES } from './syncConfig'

describe('syncConfig', () => {
  describe('SYNC_TIMEOUTS', () => {
    it('defines expected timeout values', () => {
      expect(SYNC_TIMEOUTS.docStoreFastPath).toBe(2000)
      expect(SYNC_TIMEOUTS.docStoreExtended).toBe(8000)
      expect(SYNC_TIMEOUTS.keyWait).toBe(5000)
      expect(SYNC_TIMEOUTS.recoveryCooldown).toBe(60_000)
      expect(SYNC_TIMEOUTS.localDataCleanup).toBe(5000)
      expect(SYNC_TIMEOUTS.manifestSyncInterval).toBe(3600000)
      expect(SYNC_TIMEOUTS.workerRestartDelay).toBe(1000)
      expect(SYNC_TIMEOUTS.workerShutdown).toBe(1000)
    })
  })

  describe('SYNC_BATCH_SIZES', () => {
    it('defines expected batch size values', () => {
      expect(SYNC_BATCH_SIZES.pollChunk).toBe(5)
      expect(SYNC_BATCH_SIZES.walMax).toBe(2000)
      expect(SYNC_BATCH_SIZES.walPrune).toBe(100)
      expect(SYNC_BATCH_SIZES.reencryptChunk).toBe(10)
      expect(SYNC_BATCH_SIZES.itemUpdateBatchMax).toBe(50)
    })
  })
})
