import {
  deriveVaultKey,
  encryptWithKey,
  decryptWithKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
  UnsupportedKeyDerivationError,
} from './crypto'

describe('Vault Cryptography', () => {
  it('derives a key from password and salt', async () => {
    const key = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
      saltVersion: 1,
    })
    expect(key).toBeDefined()
    expect(key.type).toBe('secret')
  })

  it('encrypts and decrypts a string with key version', async () => {
    const key = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
      saltVersion: 1,
    })
    const payload = await encryptWithKey(key, 'hello world', '2')
    expect(payload.kver).toBe('2')

    const decrypted = await decryptWithKey(key, payload)
    expect(decrypted).toBe('hello world')
  })

  it('encrypts and decrypts bytes with key version', async () => {
    const key = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
      saltVersion: 1,
    })
    const bytes = new Uint8Array([10, 20, 30, 40])
    const payload = await encryptBytesWithKey(key, bytes, '3')
    expect(payload.kver).toBe('3')

    const decrypted = await decryptBytesWithKey(key, payload)
    expect(Array.from(decrypted)).toEqual([10, 20, 30, 40])
  })

  describe('doc-bound ciphertexts', () => {
    const bytes = new Uint8Array([10, 20, 30, 40])
    let key: CryptoKey

    beforeAll(async () => {
      key = await deriveVaultKey({ password: 'password123', salt: 'somesalt', iterations: 1000, saltVersion: 1 })
    })

    it('round-trips with the same document ID', async () => {
      const payload = await encryptBytesWithKey(key, bytes, '1', 'item-a')
      expect(payload.format).toBe(2)

      const decrypted = await decryptBytesWithKey(key, payload, 'item-a')
      expect(Array.from(decrypted)).toEqual([10, 20, 30, 40])
    })

    it('does not decrypt as another document', async () => {
      const payload = await encryptBytesWithKey(key, bytes, '1', 'item-a')
      await expect(decryptBytesWithKey(key, payload, 'item-b')).rejects.toThrow()
    })

    it('needs the document ID to decrypt', async () => {
      const payload = await encryptBytesWithKey(key, bytes, '1', 'item-a')
      await expect(decryptBytesWithKey(key, payload)).rejects.toThrow('needs its document ID')
    })

    it('fails when the format flag is stripped', async () => {
      const { format: _format, ...stripped } = await encryptBytesWithKey(key, bytes, '1', 'item-a')
      await expect(decryptBytesWithKey(key, stripped, 'item-a')).rejects.toThrow()
    })

    it('rejects an unknown format', async () => {
      const payload = await encryptBytesWithKey(key, bytes, '1', 'item-a')
      await expect(
        decryptBytesWithKey(key, { ...payload, format: 3 as never }, 'item-a'),
      ).rejects.toThrow('Unsupported ciphertext format 3')
    })

    it('still decrypts ciphertexts written before binding', async () => {
      const payload = await encryptBytesWithKey(key, bytes, '1')
      expect(payload.format).toBeUndefined()

      const decrypted = await decryptBytesWithKey(key, payload, 'item-a')
      expect(Array.from(decrypted)).toEqual([10, 20, 30, 40])
    })
  })

  it('rejects salts from before saltVersion 1 without a legacy decoder', async () => {
    await expect(deriveVaultKey({ password: 'password123', salt: 'somesalt', iterations: 1000 }))
      .rejects.toBeInstanceOf(UnsupportedKeyDerivationError)
  })

  it('decodes salts from before saltVersion 1 with the legacy decoder', async () => {
    const decodeLegacySalt = vi.fn((salt: string) => new TextEncoder().encode(salt).buffer)
    const key = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
      decodeLegacySalt,
    })

    const keyBase = await crypto.subtle.importKey('raw', new TextEncoder().encode('password123'), 'PBKDF2', false, ['deriveBits'])
    const expected = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: new TextEncoder().encode('somesalt'), iterations: 1000, hash: 'SHA-256' },
      keyBase,
      256,
    )

    expect(decodeLegacySalt).toHaveBeenCalledWith('somesalt')
    expect(new Uint8Array(await crypto.subtle.exportKey('raw', key))).toEqual(new Uint8Array(expected))
  })

  it('ignores the legacy decoder for current salts', async () => {
    const decodeLegacySalt = vi.fn((salt: string) => new TextEncoder().encode(salt).buffer)
    await deriveVaultKey({ password: 'password123', salt: 'somesalt', iterations: 1000, saltVersion: 1, decodeLegacySalt })
    expect(decodeLegacySalt).not.toHaveBeenCalled()
  })
})
