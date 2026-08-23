import { attemptSessionRecovery } from './sessionRecovery'
import * as vault from './index'

describe('sessionRecovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true immediately if a session already exists', async () => {
    vi.spyOn(vault, 'getVaultSession').mockReturnValue('existing-session')
    const result = await attemptSessionRecovery('test-account')
    expect(result).toBe(true)
  })

  it('returns false if no keyHash is available', async () => {
    vi.spyOn(vault, 'getVaultSession').mockReturnValue('')
    vi.spyOn(vault, 'getKeyHash').mockReturnValue('')
    const result = await attemptSessionRecovery('test-account')
    expect(result).toBe(false)
  })

  it('successfully establishes session and syncs keyring when keyHash is available', async () => {
    vi.spyOn(vault, 'getVaultSession').mockReturnValue('')
    vi.spyOn(vault, 'getKeyHash').mockReturnValue('mock-key-hash')
    const establishSpy = vi.spyOn(vault, 'establishSessionFromKeyHash').mockResolvedValue(undefined)
    const syncSpy = vi.spyOn(vault, 'syncKeyringFromServer').mockResolvedValue(undefined)

    const result = await attemptSessionRecovery('test-account')

    expect(result).toBe(true)
    expect(establishSpy).toHaveBeenCalledWith('test-account', 'mock-key-hash')
    expect(syncSpy).toHaveBeenCalledWith('test-account')
  })

  it('returns false when establishing session throws an error', async () => {
    vi.spyOn(vault, 'getVaultSession').mockReturnValue('')
    vi.spyOn(vault, 'getKeyHash').mockReturnValue('mock-key-hash')
    vi.spyOn(vault, 'establishSessionFromKeyHash').mockRejectedValue(new Error('Network error'))

    const result = await attemptSessionRecovery('test-account')
    expect(result).toBe(false)
  })
})
