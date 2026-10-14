import {
  deriveVaultKey,
  encryptWithKey,
  decryptWithKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
} from './crypto'

describe('Vault Cryptography', () => {
  it('derives a key from password and salt', async () => {
    const key = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
    })
    expect(key).toBeDefined()
    expect(key.type).toBe('secret')
  })

  it('encrypts and decrypts a string with key version', async () => {
    const key = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
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
      key = await deriveVaultKey({ password: 'password123', salt: 'somesalt', iterations: 1000 })
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

  it('correctly uses legacy salt decoding without saltVersion', async () => {
    const keyLegacy = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
    })

    const keyModern = await deriveVaultKey({
      password: 'password123',
      salt: 'somesalt',
      iterations: 1000,
      saltVersion: 1,
    })

    const rawLegacy = await crypto.subtle.exportKey('raw', keyLegacy)
    const rawModern = await crypto.subtle.exportKey('raw', keyModern)

    expect(new Uint8Array(rawLegacy)).not.toEqual(new Uint8Array(rawModern))
  })
})
