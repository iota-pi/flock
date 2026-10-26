import type { Mock } from 'vitest'
import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { Keyring } from '../../../api/Keyring'
import { generateVaultKey } from '../../../api/crypto'
import { VaultIndexedDBStorageAdapter } from '../VaultIndexedDBStorageAdapter'
import { getAutomergeDBName } from '../AutomergeRepoManager'
import { getSealedAutomergeDBName } from '../../shared/localDatabaseNames'
import { getAccountDatabaseName, clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'
import { databaseExists } from '../../utils/databaseExists'
import { SyncWriteAheadLog } from '../SyncWriteAheadLog'
import { WorkerInternalEventHub } from '../SyncEventHub'
import { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'
import { createMockLocalForagePool } from '../__test__/testUtils'
import { LocalKeyUnavailableError } from './LocalCipher'
import { DSK_KEY, openLocalStorage, type LocalStorage, type OpenLocalStorageOptions } from './openLocalStorage'
import { UPGRADED_AT_KEY } from './LocalEncryptionUpgrade'
import type { RetireLegacyStoresOptions } from './retireLegacyStores'

const pool = createMockLocalForagePool()

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, unknown>) => pool.createInstance(config)),
  },
}))

const ACCOUNT = 'account-1'
const DOC = 'doc-1'
const SNAPSHOT = new TextEncoder().encode('Alice snapshot')
const INCREMENTAL = new TextEncoder().encode('Alice change')

async function createKeyring(versions: string[] = ['1']): Promise<Keyring> {
  const keyring = new Keyring()
  const keys = new Map<string, CryptoKey>()
  for (const version of versions) keys.set(version, await generateVaultKey())
  keyring.replace(keys, versions[versions.length - 1])
  return keyring
}

describe('openLocalStorage', () => {
  let keys: Keyring
  let opened: LocalStorage[]
  let retire: Mock<(options: RetireLegacyStoresOptions) => Promise<boolean>>

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange)
    pool.clear()
    clearAccountStoreInstancesCacheForTesting()
    keys = await createKeyring()
    opened = []
    retire = vi.fn().mockResolvedValue(true)
  })

  afterEach(async () => {
    await Promise.all(opened.map(local => local.storage.close()))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Whether the plaintext WAL database exists, as `databaseExists` would see the localforage one */
  function walExists(): boolean {
    return (pool.getInstance(getAccountDatabaseName('wal-entries', ACCOUNT), 'wal-entries')?.data.size ?? 0) > 0
  }

  async function open(overrides: Partial<OpenLocalStorageOptions> = {}): Promise<LocalStorage> {
    const local = await openLocalStorage({
      accountId: ACCOUNT,
      upgradeLocalEncryption: true,
      keys,
      randomDataKeys: true,
      databaseExists: async name => (
        name === getAccountDatabaseName('wal-entries', ACCOUNT) ? walExists() : databaseExists(name)
      ),
      upgradeDeps: { retireLegacyStores: retire },
      ...overrides,
    })
    opened.push(local)
    return local
  }

  async function seedPlaintextChunks(): Promise<void> {
    const plaintext = new VaultIndexedDBStorageAdapter(getAutomergeDBName(ACCOUNT))
    await plaintext.save([DOC, 'snapshot', 'heads-1'], SNAPSHOT)
    await plaintext.save([DOC, 'incremental', 'change-1'], INCREMENTAL)
    await plaintext.save([DOC, 'sync-state', 'peer-1'], new Uint8Array([7]))
    await plaintext.save(['storage-adapter-id'], new TextEncoder().encode('storage-1'))
    await plaintext.close()
  }

  async function readSealedMeta(key: string): Promise<unknown> {
    const sealed = new VaultIndexedDBStorageAdapter(getSealedAutomergeDBName(ACCOUNT), { version: 1, extraStores: ['meta'] })
    try {
      return await sealed.getMeta(key)
    } finally {
      await sealed.close()
    }
  }

  it('opens the plaintext database unless sealing is turned on', async () => {
    const local = await open({ upgradeLocalEncryption: false })

    expect(local.mode).toBe('plaintext')
    expect(await databaseExists(getSealedAutomergeDBName(ACCOUNT))).toBe(false)
  })

  it('creates a device key for a new device and seals chunks with it', async () => {
    const local = await open()
    await local.storage.save([DOC, 'snapshot', 'heads-1'], SNAPSHOT)

    expect(local).toMatchObject({ mode: 'sealed', retired: true })
    expect(await readSealedMeta(DSK_KEY)).toMatchObject({ kver: '1' })
    expect(await local.storage.load([DOC, 'snapshot', 'heads-1'])).toEqual(SNAPSHOT)
    expect(retire).not.toHaveBeenCalled()
  })

  it('reuses the stored device key at the next start', async () => {
    const first = await open()
    await first.storage.save([DOC, 'snapshot', 'heads-1'], SNAPSHOT)
    await first.storage.close()

    const second = await open()

    expect(await second.storage.load([DOC, 'snapshot', 'heads-1'])).toEqual(SNAPSHOT)
  })

  it('ends with one device key when two engines start at once', async () => {
    const [first, second] = await Promise.all([open(), open()])
    await first.storage.save([DOC, 'snapshot', 'heads-1'], SNAPSHOT)

    expect(await second.storage.load([DOC, 'snapshot', 'heads-1'])).toEqual(SNAPSHOT)
  })

  describe('while the active data key may be password-derived', () => {
    it('stays on plaintext storage', async () => {
      const local = await open({ randomDataKeys: false })

      expect(local.mode).toBe('plaintext')
      expect(await databaseExists(getSealedAutomergeDBName(ACCOUNT))).toBe(false)
    })

    it('seals once a random key is active', async () => {
      keys = await createKeyring(['1', '2'])

      expect((await open({ randomDataKeys: false })).mode).toBe('sealed')
    })

    it('keeps using a device key it already has', async () => {
      await (await open()).storage.close()

      expect((await open({ randomDataKeys: false })).mode).toBe('sealed')
    })
  })

  it('refuses to create a key over sealed records whose key is missing, and keeps them', async () => {
    const local = await open()
    await local.storage.save([DOC, 'snapshot', 'heads-1'], SNAPSHOT)
    await local.storage.close()
    const sealed = new VaultIndexedDBStorageAdapter(getSealedAutomergeDBName(ACCOUNT), { version: 1, extraStores: ['meta'] })
    // Simulates a lost wrap; a real meta store is never cleared on its own
    await sealed.putMeta(DSK_KEY, undefined)
    await sealed.close()

    await expect(open()).rejects.toBeInstanceOf(LocalKeyUnavailableError)
    expect(await readSealedMeta(DSK_KEY)).toBeUndefined()
    const sealedAgain = new VaultIndexedDBStorageAdapter(getSealedAutomergeDBName(ACCOUNT), { version: 1, extraStores: ['meta'] })
    expect(await sealedAgain.has([DOC, 'snapshot', 'heads-1'])).toBe(true)
    await sealedAgain.close()
  })

  it('reports the missing key version when the wrapping key is not loaded', async () => {
    keys = await createKeyring(['1', '2'])
    await (await open()).storage.close()
    keys = await createKeyring(['1'])

    const error = await open().catch(err => err)

    expect(error).toBeInstanceOf(LocalKeyUnavailableError)
    expect(error.kver).toBe('2')
  })

  describe('upgrading plaintext data', () => {
    it('copies document chunks, the storage ID, the WAL and the index, then retires the plaintext stores', async () => {
      await seedPlaintextChunks()
      const entryId = await new SyncWriteAheadLog(ACCOUNT, new WorkerInternalEventHub()).append('item-1' as ItemId, INCREMENTAL)
      const index = { accountId: ACCOUNT, itemIds: ['item-1'], tombstoneIds: [], metadata: { sort: 'name' } }
      await new IndexStore(ACCOUNT).saveIndex(index as unknown as AutomergeIndexDocument)

      const local = await open()

      expect(local).toMatchObject({ mode: 'sealed', retired: true })
      expect(await local.storage.load([DOC, 'snapshot', 'heads-1'])).toEqual(SNAPSHOT)
      expect(await local.storage.load([DOC, 'incremental', 'change-1'])).toEqual(INCREMENTAL)
      expect(await local.storage.load(['storage-adapter-id'])).toEqual(new TextEncoder().encode('storage-1'))
      expect(await local.storage.has([DOC, 'sync-state'])).toBe(false)
      const wal = await new SyncWriteAheadLog(ACCOUNT, new WorkerInternalEventHub(), { cipher: local.cipher }).readAll()
      expect(wal.get('item-1' as ItemId)).toEqual([expect.objectContaining({ id: entryId, data: INCREMENTAL })])
      expect(await new IndexStore(ACCOUNT, { cipher: local.cipher }).getIndex()).toEqual(index)
      expect(await readSealedMeta(UPGRADED_AT_KEY)).toEqual(expect.any(Number))
      expect(retire).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }))
    })

    it('copies again safely, keeping the sealed storage ID and merging deletions', async () => {
      await seedPlaintextChunks()
      await new IndexStore(ACCOUNT).saveIndex({ accountId: ACCOUNT, itemIds: ['a' as ItemId, 'b' as ItemId] })
      retire.mockResolvedValue(false)
      const first = await open()
      await first.storage.save(['storage-adapter-id'], new TextEncoder().encode('storage-sealed'))
      await new IndexStore(ACCOUNT, { cipher: first.cipher }).saveIndex({
        accountId: ACCOUNT, itemIds: ['a' as ItemId, 'b' as ItemId, 'c' as ItemId], metadata: { sort: 'sealed' },
      })
      await first.storage.close()
      // An old build's tab deleted b in the plaintext stores since
      await new IndexStore(ACCOUNT).saveIndex({
        accountId: ACCOUNT, itemIds: ['a' as ItemId], tombstoneIds: ['b' as ItemId], metadata: { sort: 'plain' },
      })

      const second = await open()

      expect(await second.storage.load(['storage-adapter-id'])).toEqual(new TextEncoder().encode('storage-sealed'))
      expect(await second.storage.load([DOC, 'snapshot', 'heads-1'])).toEqual(SNAPSHOT)
      const merged = (await new IndexStore(ACCOUNT, { cipher: second.cipher }).getIndex())!
      expect(new Set(merged.itemIds)).toEqual(new Set(['a', 'c']))
      expect(merged.tombstoneIds).toEqual(['b'])
      expect(merged.metadata).toEqual({ sort: 'sealed' })
      expect(second.retired).toBe(false)
    })

    describe('running out of space', () => {
      function failSealedSaves(): void {
        const save = VaultIndexedDBStorageAdapter.prototype.save
        vi.spyOn(VaultIndexedDBStorageAdapter.prototype, 'save').mockImplementation(async function (
          this: VaultIndexedDBStorageAdapter, key, data,
        ) {
          if ((this as unknown as { databaseName: string }).databaseName === getSealedAutomergeDBName(ACCOUNT)) {
            throw new DOMException('Quota exceeded', 'QuotaExceededError')
          }
          return save.call(this, key, data)
        })
      }

      it('runs on the plaintext stores until the first copy finishes', async () => {
        await seedPlaintextChunks()
        failSealedSaves()
        const onQuotaFallback = vi.fn()

        const local = await open({ onQuotaFallback })

        expect(local.mode).toBe('plaintext')
        expect(onQuotaFallback).toHaveBeenCalledTimes(1)
        expect(await local.storage.load([DOC, 'snapshot', 'heads-1'])).toEqual(SNAPSHOT)
      })

      it('stays sealed once a copy has finished', async () => {
        retire.mockResolvedValue(false)
        await seedPlaintextChunks()
        await (await open()).storage.close()
        failSealedSaves()

        const local = await open({ onQuotaFallback: vi.fn() })

        expect(local).toMatchObject({ mode: 'sealed', retired: false })
      })
    })
  })
})
