import { Keyring } from '../../../api/Keyring'
import { generateVaultKey } from '../../../api/crypto'
import {
  LocalCipher,
  LocalDataUnreadableError,
  LocalDecryptionError,
  LocalKeyUnavailableError,
  type LocalContext,
} from './LocalCipher'

const ACCOUNT = 'account-1'
const BYTES = new TextEncoder().encode('Alice from small group')
const AUTOMERGE: LocalContext = { store: 'automerge', key: ['doc-1', 'snapshot', 'heads-1'] }

async function createKeyring(versions: string[] = ['1'], active = versions[versions.length - 1]): Promise<Keyring> {
  const keys = new Map<string, CryptoKey>()
  for (const version of versions) {
    keys.set(version, await generateVaultKey())
  }
  const keyring = new Keyring()
  keyring.replace(keys, active)
  return keyring
}

describe('LocalCipher', () => {
  it('opens what it sealed', async () => {
    const { cipher } = await LocalCipher.create(await createKeyring(), ACCOUNT)

    const record = await cipher.seal(AUTOMERGE, BYTES)

    expect(record.v).toBe(1)
    expect(record.iv).toHaveLength(12)
    expect(Buffer.from(record.ct).includes(Buffer.from(BYTES))).toBe(false)
    expect(await cipher.open(AUTOMERGE, record)).toEqual(BYTES)
  })

  it('uses a fresh IV for every record', async () => {
    const { cipher } = await LocalCipher.create(await createKeyring(), ACCOUNT)

    const first = await cipher.seal(AUTOMERGE, BYTES)
    const second = await cipher.seal(AUTOMERGE, BYTES)

    expect(first.iv).not.toEqual(second.iv)
  })

  it.each<[string, LocalContext, LocalContext]>([
    ['another storage key', AUTOMERGE, { store: 'automerge', key: ['doc-1', 'snapshot', 'heads-2'] }],
    ['another document', AUTOMERGE, { store: 'automerge', key: ['doc-2', 'snapshot', 'heads-1'] }],
    ['a longer storage key', AUTOMERGE, { store: 'automerge', key: ['doc-1', 'snapshot', 'heads-1', 'x'] }],
    ['another store', { store: 'index' }, { store: 'wal', entryId: 'index', itemId: '' }],
    ['another WAL entry', { store: 'wal', entryId: 'e1', itemId: 'i1' }, { store: 'wal', entryId: 'e2', itemId: 'i1' }],
    ['another item', { store: 'wal', entryId: 'e1', itemId: 'i1' }, { store: 'wal', entryId: 'e1', itemId: 'i2' }],
  ])('refuses a record moved to %s', async (_case, sealedFor, openedAs) => {
    const { cipher } = await LocalCipher.create(await createKeyring(), ACCOUNT)
    const record = await cipher.seal(sealedFor, BYTES)

    await expect(cipher.open(openedAs, record)).rejects.toBeInstanceOf(LocalDecryptionError)
  })

  it('refuses a record from another account', async () => {
    const keyring = await createKeyring()
    const { cipher, wrap } = await LocalCipher.create(keyring, ACCOUNT)
    const record = await cipher.seal({ store: 'index' }, BYTES)

    // The same DSK under another account's name doesn't even unwrap
    await expect(LocalCipher.unwrap(wrap, keyring, 'account-2')).rejects.toBeInstanceOf(LocalDataUnreadableError)
    const { cipher: other } = await LocalCipher.create(keyring, 'account-2')
    await expect(other.open({ store: 'index' }, record)).rejects.toBeInstanceOf(LocalDecryptionError)
  })

  it.each([
    ['a tampered ciphertext', (record: { v: number, iv: Uint8Array, ct: Uint8Array }) => {
      record.ct[0] ^= 1
      return record
    }],
    ['an unknown format version', (record: { v: number, iv: Uint8Array, ct: Uint8Array }) => ({ ...record, v: 2 })],
    ['a plaintext record', () => ({ key: ['doc-1'], binary: BYTES })],
    ['nothing', () => undefined],
  ])('throws on %s rather than treating it as missing', async (_case, corrupt) => {
    const { cipher } = await LocalCipher.create(await createKeyring(), ACCOUNT)
    const record = await cipher.seal(AUTOMERGE, BYTES)

    await expect(cipher.open(AUTOMERGE, corrupt({ ...record, ct: new Uint8Array(record.ct) })))
      .rejects.toBeInstanceOf(LocalDecryptionError)
  })

  it('unwraps a stored DSK to the same key', async () => {
    const keyring = await createKeyring()
    const { cipher, wrap } = await LocalCipher.create(keyring, ACCOUNT)
    const record = await cipher.seal(AUTOMERGE, BYTES)

    const reopened = await LocalCipher.unwrap(wrap, keyring, ACCOUNT)

    expect(await reopened.open(AUTOMERGE, record)).toEqual(BYTES)
  })

  it('wraps the DSK with the active data key', async () => {
    const { wrap } = await LocalCipher.create(await createKeyring(['1', '2'], '2'), ACCOUNT)
    expect(wrap.kver).toBe('2')
  })

  it('reports the missing key version when the wrapping key is not loaded', async () => {
    const { wrap } = await LocalCipher.create(await createKeyring(['1', '2'], '2'), ACCOUNT)
    const olderKeyring = await createKeyring(['1'])

    const error = await LocalCipher.unwrap(wrap, olderKeyring, ACCOUNT).catch(err => err)

    expect(error).toBeInstanceOf(LocalKeyUnavailableError)
    expect(error.kver).toBe('2')
  })

  it('refuses a wrap made with a different key of the same version', async () => {
    const { wrap } = await LocalCipher.create(await createKeyring(), ACCOUNT)

    await expect(LocalCipher.unwrap(wrap, await createKeyring(), ACCOUNT))
      .rejects.toBeInstanceOf(LocalDataUnreadableError)
  })

  it('refuses a malformed wrap', async () => {
    await expect(LocalCipher.unwrap({ kver: '1' }, await createKeyring(), ACCOUNT))
      .rejects.toBeInstanceOf(LocalDataUnreadableError)
  })

  it('keeps the DSK non-extractable', async () => {
    const { cipher } = await LocalCipher.create(await createKeyring(), ACCOUNT)
    const key = (cipher as unknown as { key: CryptoKey }).key

    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  describe('rewrap', () => {
    it('wraps the same DSK with a newly active key, leaving the old wrap readable', async () => {
      const keyring = await createKeyring(['1'])
      const { cipher, wrap } = await LocalCipher.create(keyring, ACCOUNT)
      const record = await cipher.seal(AUTOMERGE, BYTES)
      keyring.addKey('2', await generateVaultKey())
      keyring.setActiveVersion('2')

      const rewrapped = await LocalCipher.rewrap(wrap, keyring, ACCOUNT)

      expect(rewrapped?.kver).toBe('2')
      expect(await (await LocalCipher.unwrap(rewrapped, keyring, ACCOUNT)).open(AUTOMERGE, record)).toEqual(BYTES)
      expect(await (await LocalCipher.unwrap(wrap, keyring, ACCOUNT)).open(AUTOMERGE, record)).toEqual(BYTES)
    })

    it('does nothing when the DSK is already wrapped with the active key', async () => {
      const keyring = await createKeyring()
      const { wrap } = await LocalCipher.create(keyring, ACCOUNT)

      expect(await LocalCipher.rewrap(wrap, keyring, ACCOUNT)).toBeNull()
    })

    it('needs the key the DSK is wrapped with', async () => {
      const { wrap } = await LocalCipher.create(await createKeyring(['1']), ACCOUNT)

      await expect(LocalCipher.rewrap(wrap, await createKeyring(['2']), ACCOUNT))
        .rejects.toBeInstanceOf(LocalKeyUnavailableError)
    })
  })
})
