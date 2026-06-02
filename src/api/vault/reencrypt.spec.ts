import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reencryptAllItems } from './reencrypt'
import { rotateVaultKey } from './index'
import { getStoredVaultKey } from './util'
import { SyncBridge } from '../../sync/SyncBridge'

vi.mock('./index', () => ({
  rotateVaultKey: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./util', () => ({
  getStoredVaultKey: vi.fn().mockReturnValue('mock-keyring-data'),
}))

vi.mock('../../sync/SyncBridge', () => ({
  SyncBridge: {
    updateVaultKey: vi.fn().mockResolvedValue(undefined),
    reencryptAllItems: vi.fn().mockImplementation(async (onProgress) => {
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
  })

  it('rotates vault key, updates sync worker keyring, and triggers worker re-encryption', async () => {
    const progressCalls: [number, number][] = []
    const onProgress = (done: number, total: number) => {
      progressCalls.push([done, total])
    }

    await reencryptAllItems(onProgress)

    expect(rotateVaultKey).toHaveBeenCalledTimes(1)
    expect(getStoredVaultKey).toHaveBeenCalledTimes(1)
    expect(SyncBridge.updateVaultKey).toHaveBeenCalledWith('mock-keyring-data')
    expect(SyncBridge.reencryptAllItems).toHaveBeenCalledWith(onProgress)
    expect(progressCalls).toEqual([
      [5, 10],
      [10, 10],
    ])
  })

  it('throws an error if keyring is missing after rotation', async () => {
    vi.mocked(getStoredVaultKey).mockReturnValueOnce(null)

    await expect(reencryptAllItems()).rejects.toThrow('Keyring not found in storage after rotation')

    expect(rotateVaultKey).toHaveBeenCalledTimes(1)
    expect(SyncBridge.updateVaultKey).not.toHaveBeenCalled()
    expect(SyncBridge.reencryptAllItems).not.toHaveBeenCalled()
  })
})
