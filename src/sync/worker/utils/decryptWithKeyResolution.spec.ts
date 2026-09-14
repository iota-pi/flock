import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decryptWithKeyResolution, MissingKeyError } from './decryptWithKeyResolution'

const mockDecryptBytes = vi.fn()
const mockHasVaultKey = vi.fn()
const mockWaitForKeyVersion = vi.fn()

vi.mock('src/api/vault', () => ({
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
  hasVaultKey: (...args: any[]) => mockHasVaultKey(...args),
  waitForKeyVersion: (...args: any[]) => mockWaitForKeyVersion(...args),
}))

describe('decryptWithKeyResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasVaultKey.mockReturnValue(true)
    mockWaitForKeyVersion.mockResolvedValue(true)
    mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
  })

  it('decrypts immediately when key is available in keyring (object form)', async () => {
    const payload = { cipher: 'c-1', iv: 'iv-1', kver: '1' }
    const result = await decryptWithKeyResolution(payload)

    expect(result).toEqual(new Uint8Array([1, 2, 3]))
    expect(mockHasVaultKey).toHaveBeenCalledWith('1')
    expect(mockWaitForKeyVersion).not.toHaveBeenCalled()
    expect(mockDecryptBytes).toHaveBeenCalledWith(payload)
  })

  it('decrypts immediately when key is available in keyring (4-arg form)', async () => {
    const result = await decryptWithKeyResolution('c-1', 'iv-1', '2', { timeoutMs: 1000 })

    expect(result).toEqual(new Uint8Array([1, 2, 3]))
    expect(mockHasVaultKey).toHaveBeenCalledWith('2')
    expect(mockWaitForKeyVersion).not.toHaveBeenCalled()
    expect(mockDecryptBytes).toHaveBeenCalledWith({ cipher: 'c-1', iv: 'iv-1', kver: '2' })
  })

  it('defaults kver to "1" if undefined', async () => {
    const result = await decryptWithKeyResolution({ cipher: 'c-1', iv: 'iv-1' })

    expect(result).toEqual(new Uint8Array([1, 2, 3]))
    expect(mockHasVaultKey).toHaveBeenCalledWith('1')
    expect(mockDecryptBytes).toHaveBeenCalledWith({ cipher: 'c-1', iv: 'iv-1', kver: '1' })
  })

  it('fires onKeyVersionMissing and waits for key when key is not initially available', async () => {
    mockHasVaultKey.mockImplementation((kver?: string) => kver !== '2')
    mockWaitForKeyVersion.mockImplementation(async (kver: string) => {
      // Simulate key arriving
      mockHasVaultKey.mockReturnValue(true)
      return true
    })

    const onKeyVersionMissing = vi.fn()
    const result = await decryptWithKeyResolution(
      { cipher: 'c-2', iv: 'iv-2', kver: '2' },
      { timeoutMs: 3000, onKeyVersionMissing },
    )

    expect(onKeyVersionMissing).toHaveBeenCalledWith('2')
    expect(mockWaitForKeyVersion).toHaveBeenCalledWith('2', 3000)
    expect(result).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('throws MissingKeyError and records in timedOutKeys on wait timeout', async () => {
    mockHasVaultKey.mockReturnValue(false)
    mockWaitForKeyVersion.mockResolvedValue(false)

    const timedOutKeys = new Set<string>()
    const onKeyVersionMissing = vi.fn()

    await expect(
      decryptWithKeyResolution(
        { cipher: 'c-3', iv: 'iv-3', kver: '3' },
        { timeoutMs: 2000, onKeyVersionMissing, timedOutKeys },
      ),
    ).rejects.toThrow(MissingKeyError)

    expect(onKeyVersionMissing).toHaveBeenCalledWith('3')
    expect(mockWaitForKeyVersion).toHaveBeenCalledWith('3', 2000)
    expect(timedOutKeys.has('3')).toBe(true)
  })

  it('skips wait if key is already in timedOutKeys', async () => {
    mockHasVaultKey.mockReturnValue(false)
    const timedOutKeys = new Set<string>(['4'])
    const onKeyVersionMissing = vi.fn()

    await expect(
      decryptWithKeyResolution(
        { cipher: 'c-4', iv: 'iv-4', kver: '4' },
        { timedOutKeys, onKeyVersionMissing },
      ),
    ).rejects.toThrow(MissingKeyError)

    expect(onKeyVersionMissing).not.toHaveBeenCalled()
    expect(mockWaitForKeyVersion).not.toHaveBeenCalled()
  })

  it('skips wait if skipWait is true or returns true', async () => {
    mockHasVaultKey.mockReturnValue(false)
    const onKeyVersionMissing = vi.fn()

    await expect(
      decryptWithKeyResolution(
        { cipher: 'c-5', iv: 'iv-5', kver: '5' },
        { skipWait: (kver) => kver === '5', onKeyVersionMissing },
      ),
    ).rejects.toThrow(MissingKeyError)

    expect(onKeyVersionMissing).not.toHaveBeenCalled()
    expect(mockWaitForKeyVersion).not.toHaveBeenCalled()
  })

  it('catches keyring missing errors during decryptBytes and converts to MissingKeyError', async () => {
    mockHasVaultKey.mockReturnValue(true)
    mockDecryptBytes.mockRejectedValue(new Error('Vault key version 6 not found in keyring'))

    const timedOutKeys = new Set<string>()
    await expect(
      decryptWithKeyResolution(
        { cipher: 'c-6', iv: 'iv-6', kver: '6' },
        { timedOutKeys },
      ),
    ).rejects.toThrow(MissingKeyError)

    expect(timedOutKeys.has('6')).toBe(true)
  })

  it('re-throws non-key errors from decryptBytes unchanged', async () => {
    mockHasVaultKey.mockReturnValue(true)
    mockDecryptBytes.mockRejectedValue(new Error('Ciphertext corrupted or bad MAC'))

    await expect(
      decryptWithKeyResolution({ cipher: 'bad', iv: 'iv-bad', kver: '1' }),
    ).rejects.toThrow('Ciphertext corrupted or bad MAC')
  })
})
