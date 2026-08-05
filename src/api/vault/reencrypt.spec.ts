import { reencryptAllItems } from './reencrypt'
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
  })

  it('throws an error if keyring is missing after rotation', async () => {
    vi.mocked(exportKeyringData).mockResolvedValueOnce('')

    await expect(reencryptAllItems('test-account')).rejects.toThrow('Keyring not found in memory after rotation')

    expect(rotateVaultKey).toHaveBeenCalledTimes(1)
    expect(SyncBridge.updateVaultKey).not.toHaveBeenCalled()
    expect(SyncBridge.reencryptAllItems).not.toHaveBeenCalled()
  })
})

