import { generateVaultKey } from './crypto'
import { Keyring, VaultNotInitializedError } from './Keyring'

async function keyringWith(versions: string[], activeVersion = versions[versions.length - 1]) {
  const keyring = new Keyring()
  const keys = new Map<string, CryptoKey>()
  for (const ver of versions) {
    keys.set(ver, await generateVaultKey())
  }
  keyring.replace(keys, activeVersion)
  return keyring
}

describe('Keyring', () => {
  it('starts empty', () => {
    const keyring = new Keyring()
    expect(keyring.hasKey()).toBe(false)
    expect(keyring.hasKey('1')).toBe(false)
    expect(() => keyring.getKey()).toThrow(VaultNotInitializedError)
    expect(() => keyring.getKey('1')).toThrow('Vault key version 1 not found in keyring')
  })

  it('encrypts with the active key and decrypts with the version a ciphertext names', async () => {
    const keyring = await keyringWith(['1', '2'])

    const encrypted = await keyring.encryptBytes(new Uint8Array([1, 2, 3]))
    expect(encrypted.kver).toBe('2')
    await expect(keyring.decryptBytes(encrypted)).resolves.toEqual(new Uint8Array([1, 2, 3]))

    const text = await keyring.encrypt('hello')
    await expect(keyring.decrypt(text)).resolves.toBe('hello')
  })

  it('binds ciphertexts to a document when given its ID', async () => {
    const keyring = await keyringWith(['1'])

    const bound = await keyring.encryptBytes(new Uint8Array([4, 5]), 'item-1')
    expect(bound.format).toBe(2)
    await expect(keyring.decryptBytes(bound, 'item-1')).resolves.toEqual(new Uint8Array([4, 5]))
    await expect(keyring.decryptBytes(bound, 'item-2')).rejects.toThrow()

    const unbound = await keyring.encryptBytes(new Uint8Array([6]))
    expect(unbound.format).toBeUndefined()
    await expect(keyring.decryptBytes(unbound)).resolves.toEqual(new Uint8Array([6]))
  })

  it('loads a keyring exported from another realm', async () => {
    const source = await keyringWith(['1', '2'])
    const exported = JSON.stringify(await source.export())

    const target = new Keyring()
    await target.load(exported)

    expect(target.activeVersion).toBe('2')
    const encrypted = await source.encryptBytes(new Uint8Array([7]), 'item-1')
    await expect(target.decryptBytes(encrypted, 'item-1')).resolves.toEqual(new Uint8Array([7]))
  })

  it('exports with an overridden active version', async () => {
    const keyring = await keyringWith(['1', '2'], '1')
    const exported = await keyring.export('2')
    expect(exported.activeVersion).toBe('2')
    expect(Object.keys(exported).sort()).toEqual(['1', '2', 'activeVersion'])
  })

  describe('waiting for a key', () => {
    it('resolves straight away when the key is loaded', async () => {
      const keyring = await keyringWith(['1'])
      await expect(keyring.waitForKey('1', 10)).resolves.toBe(true)
    })

    it('resolves when a load brings the key in', async () => {
      const source = await keyringWith(['1'])
      const keyring = new Keyring()

      const wait = keyring.waitForKey('1', 2000)
      await keyring.load(JSON.stringify(await source.export()))

      await expect(wait).resolves.toBe(true)
    })

    it('resolves when the key is added or becomes active', async () => {
      const keyring = await keyringWith(['1'])
      const wait = keyring.waitForKey('2', 2000)

      keyring.addKey('2', await generateVaultKey())
      await expect(wait).resolves.toBe(true)
    })

    it('resolves false on timeout', async () => {
      const keyring = new Keyring()
      await expect(keyring.waitForKey('3', 10)).resolves.toBe(false)
    })

    it('resolves false when the keyring is cleared', async () => {
      const keyring = new Keyring()
      const wait = keyring.waitForKey('1', 2000)

      keyring.clear()
      await expect(wait).resolves.toBe(false)
    })
  })

  describe('load', () => {
    it('never leaves the keyring empty while a new keyring loads', async () => {
      const keyring = await keyringWith(['1'])
      const next = await keyringWith(['1', '2'])

      const loading = keyring.load(JSON.stringify(await next.export()))
      expect(keyring.hasKey('1')).toBe(true)
      await Promise.resolve()
      expect(keyring.hasKey('1')).toBe(true)

      await loading
      expect(keyring.hasKey('2')).toBe(true)
      expect(keyring.activeVersion).toBe('2')
    })

    it('keeps the current keys when the keyring cannot be loaded', async () => {
      const keyring = await keyringWith(['1'])

      await expect(keyring.load('not-a-valid-key')).rejects.toThrow()
      await expect(keyring.load(JSON.stringify({ foo: 'bar' }))).rejects.toThrow('Not a structured keyring')
      await expect(keyring.load(JSON.stringify({ activeVersion: '1' }))).rejects.toThrow('Keyring contains no key entries')

      expect(keyring.hasKey('1')).toBe(true)
    })
  })
})
