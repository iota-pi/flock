import { reencryptAllItems, resumePendingReencryption, REENCRYPT_PENDING_KEY_PREFIX } from './reencrypt'
import { rotateVaultKey, exportKeyringData } from './index'
import { SyncBridge } from '../../sync/client/SyncBridge'


vi.mock('./index', () => ({
  rotateVaultKey: vi.fn().mockResolvedValue(undefined),
  exportKeyringData: vi.fn().mockResolvedValue('mock-keyring-data'),
}))

vi.mock('../../sync/client/SyncBridge', () => ({
  SyncBridge: {
    updateVaultKey: vi.fn().mockResolvedValue(undefined),
    reencryptAllItems: vi.fn().mockImplementation(async onProgress => {
      if (onProgress) {
        onProgress(5, 10)
        onProgress(10, 10)
      }
    }),
  },
}))

describe('reencryptAllItems coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('rotates vault key, updates sync worker keyring, and triggers worker re-encryption', async () => {
    const progressCalls: [number, number][] = []
    const onProgress = (done: number, total: number) => {
      progressCalls.push([done, total])
    }

    await reencryptAllItems('test-account', onProgress)

    expect(rotateVaultKey).toHaveBeenCalledTimes(1)
    expect(exportKeyringData).toHaveBeenCalledTimes(1)
    expect(SyncBridge.updateVaultKey).toHaveBeenCalledWith('mock-keyring-data')
    expect(SyncBridge.reencryptAllItems).toHaveBeenCalledWith(onProgress)
    expect(progressCalls).toEqual([
      [5, 10],
      [10, 10],
    ])
    expect(localStorage.getItem(`${REENCRYPT_PENDING_KEY_PREFIX}test-account`)).toBeNull()
  })

  it('throws an error if keyring is missing after rotation', async () => {
    vi.mocked(exportKeyringData).mockResolvedValueOnce('')

    await expect(reencryptAllItems('test-account')).rejects.toThrow('Keyring not found in memory after rotation')

    expect(rotateVaultKey).toHaveBeenCalledTimes(1)
    expect(SyncBridge.updateVaultKey).not.toHaveBeenCalled()
    expect(SyncBridge.reencryptAllItems).not.toHaveBeenCalled()
    // Intent flag should remain set for crash recovery
    expect(localStorage.getItem(`${REENCRYPT_PENDING_KEY_PREFIX}test-account`)).toBe('true')
  })

  it('fails early and does not update worker or re-encrypt items when rotateVaultKey fails', async () => {
    vi.mocked(rotateVaultKey).mockRejectedValueOnce(
      new Error('Key rotation failed: keyring upload unsuccessful. Local state rolled back.')
    )

    await expect(reencryptAllItems('test-account')).rejects.toThrow(
      'Key rotation failed: keyring upload unsuccessful. Local state rolled back.'
    )

    expect(rotateVaultKey).toHaveBeenCalledTimes(1)
    expect(exportKeyringData).not.toHaveBeenCalled()
    expect(SyncBridge.updateVaultKey).not.toHaveBeenCalled()
    expect(SyncBridge.reencryptAllItems).not.toHaveBeenCalled()
  })

  describe('resumePendingReencryption', () => {
    it('does nothing if no re-encryption is pending', async () => {
      await resumePendingReencryption('test-account')

      expect(SyncBridge.reencryptAllItems).not.toHaveBeenCalled()
    })

    it('resumes re-encryption and clears pending flag if flag is set', async () => {
      localStorage.setItem(`${REENCRYPT_PENDING_KEY_PREFIX}test-account`, 'true')

      await resumePendingReencryption('test-account')

      expect(SyncBridge.reencryptAllItems).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(`${REENCRYPT_PENDING_KEY_PREFIX}test-account`)).toBeNull()
    })

    it('retains pending flag if resume re-encryption fails', async () => {
      localStorage.setItem(`${REENCRYPT_PENDING_KEY_PREFIX}test-account`, 'true')
      vi.mocked(SyncBridge.reencryptAllItems).mockRejectedValueOnce(new Error('Network error'))

      await resumePendingReencryption('test-account')

      expect(SyncBridge.reencryptAllItems).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem(`${REENCRYPT_PENDING_KEY_PREFIX}test-account`)).toBe('true')
    })
  })
})

