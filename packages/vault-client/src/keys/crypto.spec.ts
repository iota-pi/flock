import * as Comlink from 'comlink'
import {
  deriveVaultKey,
  encryptWithKey,
  decryptWithKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
  UnsupportedKeyDerivationError,
} from './crypto'
import {
  assertKdfAcceptable,
  assertPbkdf2Acceptable,
  computeArgon2id,
  deriveArgon2idBytes,
  KDF_WORKER_TIMEOUT_MS,
  PRODUCTION_KDF_LIMITS,
  setKdfWorkerFactory,
  type KdfParams,
  type KdfWorkerApi,
} from './kdf'
import { deriveLegacyKey } from '../../test/deriveLegacyKey'
import { getDefaultKdf } from '@vault/shared'

const PRODUCTION_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 65536, passes: 3, parallelism: 1 }

function testKey() {
  return deriveVaultKey({ password: 'password123', salt: 'c29tZXNhbHQ=', kdf: getDefaultKdf(), saltVersion: 1 })
}

async function rawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key))
}

describe('Vault Cryptography', () => {
  it('encrypts and decrypts a string with key version', async () => {
    const key = await testKey()
    const payload = await encryptWithKey(key, 'hello world', '2')
    expect(payload.kver).toBe('2')

    const decrypted = await decryptWithKey(key, payload)
    expect(decrypted).toBe('hello world')
  })

  it('encrypts and decrypts bytes with key version', async () => {
    const key = await testKey()
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
      key = await testKey()
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

  describe('Argon2id', () => {
    it('matches the reference implementation', async () => {
      // argon2id, v=0x13, t=2, m=2^16 KiB, p=1 from the reference implementation's test vectors
      const hash = await computeArgon2id(
        'password',
        new TextEncoder().encode('somesalt'),
        { algorithm: 'argon2id', memoryKiB: 65536, passes: 2, parallelism: 1 },
      )
      expect(hash.toHex()).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7')
    })

    it('derives the master key from the Argon2id output', async () => {
      const key = await deriveVaultKey({ password: 'password123', salt: 'c29tZXNhbHQ=', kdf: getDefaultKdf(), saltVersion: 1 })
      const expected = await computeArgon2id('password123', Uint8Array.fromBase64('c29tZXNhbHQ='), getDefaultKdf())

      expect(key.type).toBe('secret')
      expect(await rawKey(key)).toEqual(expected)
    })

    it('refuses parameters below the minimum before deriving', async () => {
      await expect(deriveVaultKey({
        password: 'password123',
        salt: 'c29tZXNhbHQ=',
        kdf: { ...getDefaultKdf(), memoryKiB: getDefaultKdf().memoryKiB - 1 },
        saltVersion: 1,
      })).rejects.toBeInstanceOf(UnsupportedKeyDerivationError)
    })

    it('runs in a fresh worker when one is configured, and terminates it', async () => {
      const terminate = vi.fn()
      const createWorker = vi.fn(() => {
        const { port1, port2 } = new MessageChannel()
        const api: KdfWorkerApi = { deriveArgon2id: computeArgon2id }
        Comlink.expose(api, port2)
        return Object.assign(port1, { terminate }) as unknown as Worker
      })
      setKdfWorkerFactory(createWorker)
      try {
        const salt = new TextEncoder().encode('somesaltsomesalt')
        const fromWorker = await deriveArgon2idBytes('password123', salt, getDefaultKdf())
        expect(fromWorker).toEqual(await computeArgon2id('password123', salt, getDefaultKdf()))
        expect(createWorker).toHaveBeenCalledTimes(1)
        expect(terminate).toHaveBeenCalledTimes(1)
      } finally {
        setKdfWorkerFactory(undefined)
      }
    })

    describe('when the worker lets the derivation down', () => {
      const salt = new TextEncoder().encode('somesaltsomesalt')
      let terminate: ReturnType<typeof vi.fn>

      /** A worker that takes requests but never answers them, like one whose script failed to load */
      function silentWorker() {
        const worker = Object.assign(new EventTarget(), { postMessage: vi.fn(), terminate }) as unknown as Worker
        return worker
      }

      beforeEach(() => {
        terminate = vi.fn()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
      })

      afterEach(() => {
        setKdfWorkerFactory(undefined)
        vi.useRealTimers()
        vi.restoreAllMocks()
      })

      it('derives here instead when the worker fails to load', async () => {
        const worker = silentWorker()
        setKdfWorkerFactory(() => worker)

        const derivation = deriveArgon2idBytes('password123', salt, getDefaultKdf())
        worker.dispatchEvent(new Event('error'))

        await expect(derivation).resolves.toEqual(await computeArgon2id('password123', salt, getDefaultKdf()))
        expect(terminate).toHaveBeenCalledTimes(1)
      })

      it('derives here instead when the worker never answers', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        setKdfWorkerFactory(silentWorker)

        const derivation = deriveArgon2idBytes('password123', salt, getDefaultKdf())
        await vi.advanceTimersByTimeAsync(KDF_WORKER_TIMEOUT_MS)

        await expect(derivation).resolves.toEqual(await computeArgon2id('password123', salt, getDefaultKdf()))
        expect(terminate).toHaveBeenCalledTimes(1)
      })

      it('derives here instead when the worker can\'t be created', async () => {
        setKdfWorkerFactory(() => {
          throw new Error('Module workers are not supported')
        })

        await expect(deriveArgon2idBytes('password123', salt, getDefaultKdf()))
          .resolves.toEqual(await computeArgon2id('password123', salt, getDefaultKdf()))
      })
    })
  })

  describe('parameter limits', () => {
    it('accepts the production defaults', () => {
      expect(() => assertKdfAcceptable(PRODUCTION_KDF, PRODUCTION_KDF_LIMITS)).not.toThrow()
    })

    it.each([
      ['memory', { memoryKiB: 65535 }],
      ['passes', { passes: 2 }],
      ['parallelism', { parallelism: 0 }],
    ])('refuses %s below the minimum', (_name, change) => {
      expect(() => assertKdfAcceptable({ ...PRODUCTION_KDF, ...change }, PRODUCTION_KDF_LIMITS))
        .toThrow(UnsupportedKeyDerivationError)
    })

    it.each([
      ['memory', { memoryKiB: 256 * 1024 + 1 }],
      ['passes', { passes: 11 }],
      ['parallelism', { parallelism: 5 }],
    ])('refuses %s above the maximum', (_name, change) => {
      expect(() => assertKdfAcceptable({ ...PRODUCTION_KDF, ...change }, PRODUCTION_KDF_LIMITS))
        .toThrow(UnsupportedKeyDerivationError)
    })

    it('refuses other algorithms', () => {
      expect(() => assertKdfAcceptable({ ...PRODUCTION_KDF, algorithm: 'argon2i' as never }, PRODUCTION_KDF_LIMITS))
        .toThrow(UnsupportedKeyDerivationError)
    })

    it('refuses fewer PBKDF2 iterations than any release has written', () => {
      expect(() => assertPbkdf2Acceptable(100_000, PRODUCTION_KDF_LIMITS)).not.toThrow()
      expect(() => assertPbkdf2Acceptable(99_999, PRODUCTION_KDF_LIMITS)).toThrow(UnsupportedKeyDerivationError)
    })
  })

  describe('PBKDF2', () => {
    it('derives through the app\'s legacy hook', async () => {
      const hook = vi.fn(deriveLegacyKey)
      const key = await deriveVaultKey({
        password: 'password123',
        salt: 'c29tZXNhbHQ=',
        iterations: 1000,
        saltVersion: 1,
        deriveLegacyKey: hook,
      })

      expect(hook).toHaveBeenCalledWith({ password: 'password123', salt: expect.any(ArrayBuffer), iterations: 1000 })
      expect(await rawKey(key)).toEqual(new Uint8Array(await hook.mock.results[0]!.value))
    })

    it('is refused without the legacy hook', async () => {
      await expect(deriveVaultKey({ password: 'password123', salt: 'c29tZXNhbHQ=', iterations: 1000, saltVersion: 1 }))
        .rejects.toBeInstanceOf(UnsupportedKeyDerivationError)
    })

    it('rejects salts from before saltVersion 1 without a legacy decoder', async () => {
      await expect(deriveVaultKey({ password: 'password123', salt: 'somesalt', iterations: 1000, deriveLegacyKey }))
        .rejects.toThrow(/Unsupported salt version/)
    })

    it('decodes salts from before saltVersion 1 with the legacy decoder', async () => {
      const decodeLegacySalt = vi.fn((salt: string) => new TextEncoder().encode(salt).buffer)
      const key = await deriveVaultKey({
        password: 'password123',
        salt: 'somesalt',
        iterations: 1000,
        decodeLegacySalt,
        deriveLegacyKey,
      })

      const keyBase = await crypto.subtle.importKey('raw', new TextEncoder().encode('password123'), 'PBKDF2', false, ['deriveBits'])
      const expected = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: new TextEncoder().encode('somesalt'), iterations: 1000, hash: 'SHA-256' },
        keyBase,
        256,
      )

      expect(decodeLegacySalt).toHaveBeenCalledWith('somesalt')
      expect(await rawKey(key)).toEqual(new Uint8Array(expected))
    })

    it('ignores the legacy decoder for current salts', async () => {
      const decodeLegacySalt = vi.fn((salt: string) => new TextEncoder().encode(salt).buffer)
      await deriveVaultKey({ password: 'password123', salt: 'c29tZXNhbHQ=', iterations: 1000, saltVersion: 1, decodeLegacySalt, deriveLegacyKey })
      expect(decodeLegacySalt).not.toHaveBeenCalled()
    })
  })
})
