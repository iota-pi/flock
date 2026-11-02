import type { Mock } from 'vitest'
import localforage from 'localforage'
import { Keyring, type KeyProvider } from '../../../api/Keyring'
import { generateVaultKey } from '../../../api/crypto'
import { LocalCipher } from '../localEncryption/LocalCipher'
import type { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore, type AutomergeDocStoreOptions, type ItemLockCoordinator } from '../docStore/AutomergeDocStore'
import { passthroughCodec } from '../domain'
import * as vaultTrpcClientModule from '../../../api/vaultTrpcClient'
import { spyOnExports } from '../../../../test/moduleMocks'
import type { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import type { SnapshotTracker } from '../SnapshotTracker'
import type { ItemSyncTimestamps } from '../stores/LastModifiedStore'
import type { RealtimeBus } from '../realtimeBus'
import type { VaultMetadata } from '../../shared/types'

/** A real local cipher over a fresh one-key keyring */
export async function createTestLocalCipher(accountId = 'test-account'): Promise<LocalCipher> {
  const keyring = new Keyring()
  keyring.replace(new Map([['1', await generateVaultKey()]]), '1')
  return (await LocalCipher.create(keyring, accountId)).cipher
}

/**
 * Mock LocalForage storage instance implementing common localforage methods.
 */
export class MockLocalforage {
  public data = new Map<string, any>()
  public config?: Record<string, any>
  public _config?: Record<string, any>

  get store(): Map<string, any> {
    return this.data
  }

  set store(val: Map<string, any>) {
    this.data = val
  }

  constructor(
    configOrInitialData?: Record<string, any> | Map<string, any> | [string, any][],
    initialData?: Record<string, any> | Map<string, any> | [string, any][],
  ) {
    let resolvedConfig: Record<string, any> | undefined
    let resolvedData: Record<string, any> | Map<string, any> | [string, any][] | undefined

    if (initialData !== undefined) {
      resolvedConfig = configOrInitialData as Record<string, any>
      resolvedData = initialData
    } else if (configOrInitialData) {
      if (configOrInitialData instanceof Map || Array.isArray(configOrInitialData)) {
        resolvedData = configOrInitialData
      } else if ('name' in configOrInitialData || 'storeName' in configOrInitialData) {
        resolvedConfig = configOrInitialData
      } else {
        resolvedData = configOrInitialData
      }
    }

    this.config = resolvedConfig
    this._config = resolvedConfig ?? { storeName: 'test-store' }

    if (resolvedData) {
      if (resolvedData instanceof Map) {
        for (const [k, v] of resolvedData.entries()) {
          this.data.set(k, v)
        }
      } else if (Array.isArray(resolvedData)) {
        for (const [k, v] of resolvedData) {
          this.data.set(k, v)
        }
      } else {
        for (const [k, v] of Object.entries(resolvedData)) {
          this.data.set(k, v)
        }
      }
    }
  }

  getItem = vi.fn().mockImplementation(async <T = any>(key: string): Promise<T | null> => {
    return (this.data.get(key) as T) ?? null
  })

  setItem = vi.fn().mockImplementation(async <T = any>(key: string, value: T): Promise<T> => {
    this.data.set(key, value)
    return value
  })

  removeItem = vi.fn().mockImplementation(async (key: string): Promise<void> => {
    this.data.delete(key)
  })

  clear = vi.fn().mockImplementation(async (): Promise<void> => {
    this.data.clear()
  })

  keys = vi.fn().mockImplementation(async (): Promise<string[]> => {
    return Array.from(this.data.keys())
  })

  length = vi.fn().mockImplementation(async (): Promise<number> => {
    return this.data.size
  })

  iterate = vi.fn().mockImplementation(
    async <T = any, U = any>(
      iteratee: (value: T, key: string, iterationNumber: number) => U,
    ): Promise<U> => {
      let i = 0
      for (const [key, val] of this.data.entries()) {
        const result = iteratee(val, key, i)
        if (result !== undefined) {
          return result
        }
        i += 1
      }
      return undefined as unknown as U
    },
  )

  reset(): void {
    this.data.clear()
    this.getItem.mockClear()
    this.setItem.mockClear()
    this.removeItem.mockClear()
    this.clear.mockClear()
    this.keys.mockClear()
    this.length.mockClear()
    this.iterate.mockClear()
  }
}

/**
 * Creates a MockLocalforage instance, optionally populated with initial data or configured with DB/store options.
 */
export function createMockLocalForage(
  configOrInitialData?: Record<string, any> | Map<string, any> | [string, any][],
  initialData?: Record<string, any> | Map<string, any> | [string, any][],
): MockLocalforage {
  return new MockLocalforage(configOrInitialData, initialData)
}

export interface MockLocalForagePool {
  instances: Map<string, MockLocalforage>
  createInstance: Mock<(config?: Record<string, any>) => MockLocalforage>
  getInstance: (name: string, storeName: string) => MockLocalforage | undefined
  getOrCreateInstance: (config?: Record<string, any>) => MockLocalforage
  clear: () => void
  reset: () => void
}

/**
 * Creates a pool of MockLocalforage instances keyed by `${name}#${storeName}` (or custom key)
 * suitable for mocking localforage.createInstance.
 */
export function createMockLocalForagePool(): MockLocalForagePool {
  const instances = new Map<string, MockLocalforage>()
  const createInstance = vi.fn().mockImplementation((config: Record<string, any> = {}) => {
    const key = `${config.name ?? ''}#${config.storeName ?? ''}`
    let inst = instances.get(key)
    if (!inst) {
      inst = new MockLocalforage(config)
      instances.set(key, inst)
    }
    return inst
  })

  return {
    instances,
    createInstance,
    getInstance: (name: string, storeName: string) => instances.get(`${name}#${storeName}`),
    getOrCreateInstance: (config: Record<string, any> = {}) => {
      const key = `${config.name ?? ''}#${config.storeName ?? ''}`
      let inst = instances.get(key)
      if (!inst) {
        inst = new MockLocalforage(config)
        instances.set(key, inst)
      }
      return inst
    },
    clear: () => instances.clear(),
    reset: () => {
      for (const inst of instances.values()) {
        inst.reset()
      }
      instances.clear()
    },
  }
}

/**
 * Serves `localforage.createInstance` from `createInstance` (by default, a fresh pool) for the
 * current test. Call it in `beforeEach`: test files share module state, and spies are restored
 * after every test.
 */
export function mockLocalForage(
  createInstance: (config: any) => unknown = createMockLocalForagePool().createInstance,
) {
  return vi.spyOn(localforage, 'createInstance').mockImplementation(createInstance as typeof localforage.createInstance)
}

export interface MockVault {
  decryptBytes: Mock<(...args: any[]) => Promise<any>>
  decryptObject: Mock<(...args: any[]) => Promise<any>>
  encryptBytes: Mock<(...args: any[]) => Promise<any>>
  encryptObject: Mock<(...args: any[]) => Promise<any>>
  hasVaultKey: Mock<(...args: any[]) => any>
  waitForKeyVersion: Mock<(...args: any[]) => any>
  reset: () => void
}

/**
 * Creates a mocked vault crypto suite with sensible defaults (all keys present, fast resolution, identity decrypt).
 */
export function createMockVault(overrides?: Partial<MockVault>): MockVault {
  const mockVault: MockVault = {
    decryptBytes: vi.fn().mockImplementation(async (encrypted: any) => {
      if (encrypted?.cipher === 'corrupt-cipher') {
        throw new Error('Decryption failure: MAC mismatch')
      }
      if (encrypted?.cipher !== undefined) {
        return encrypted.cipher
      }
      if (encrypted instanceof Uint8Array) {
        return encrypted
      }
      return new Uint8Array([1, 2, 3])
    }),
    decryptObject: vi.fn().mockImplementation(async (encrypted: any) => {
      if (encrypted?.cipher) {
        try {
          return JSON.parse(encrypted.cipher)
        } catch {
          return encrypted.cipher
        }
      }
      return {}
    }),
    encryptBytes: vi.fn().mockImplementation(async (bytes: Uint8Array) => ({
      iv: 'mock-iv',
      cipher: 'mock-cipher-' + (bytes?.length ?? 0),
      kver: '1',
    })),
    encryptObject: vi.fn().mockImplementation(async (obj: any) => ({
      iv: 'mock-iv',
      cipher: 'mock-cipher-' + JSON.stringify(obj),
      kver: '1',
    })),
    hasVaultKey: vi.fn().mockReturnValue(true),
    waitForKeyVersion: vi.fn().mockResolvedValue(true),
    reset: () => {
      mockVault.decryptBytes.mockReset().mockImplementation(async (encrypted: any) => {
        if (encrypted?.cipher === 'corrupt-cipher') {
          throw new Error('Decryption failure: MAC mismatch')
        }
        if (encrypted?.cipher !== undefined) {
          return encrypted.cipher
        }
        if (encrypted instanceof Uint8Array) {
          return encrypted
        }
        return new Uint8Array([1, 2, 3])
      })
      mockVault.decryptObject.mockReset().mockResolvedValue({})
      mockVault.encryptBytes.mockReset().mockImplementation(async (bytes: Uint8Array) => ({
        iv: 'mock-iv',
        cipher: 'mock-cipher-' + (bytes?.length ?? 0),
        kver: '1',
      }))
      mockVault.encryptObject.mockReset().mockImplementation(async () => ({
        iv: 'mock-iv',
        cipher: 'mock-cipher',
        kver: '1',
      }))
      mockVault.hasVaultKey.mockReset().mockReturnValue(true)
      mockVault.waitForKeyVersion.mockReset().mockResolvedValue(true)
    },
    ...overrides,
  }

  return mockVault
}

/**
 * A KeyProvider backed by a mock vault's functions, so specs can stub and assert on them
 */
export function createMockKeyProvider(
  vault: Pick<MockVault, 'hasVaultKey' | 'waitForKeyVersion' | 'encryptBytes' | 'decryptBytes'> = createMockVault(),
): KeyProvider {
  return {
    hasKey: kver => vault.hasVaultKey(kver),
    waitForKey: (kver, timeoutMs) => vault.waitForKeyVersion(kver, timeoutMs),
    encryptBytes: (bytes, docId) => vault.encryptBytes(bytes, docId),
    decryptBytes: (data, docId) => vault.decryptBytes(data, docId),
  }
}

/** A doc store over `repo` with the passthrough codec and every document readable */
export function createTestDocStore(repo: Repo, overrides?: Partial<AutomergeDocStoreOptions>): AutomergeDocStore {
  return new AutomergeDocStore({
    repo,
    codec: passthroughCodec,
    isLocallyUnreadable: () => false,
    ...overrides,
  })
}

/** Runs each task straight away, for components tested without a doc store's item locks */
export const noItemLocks: ItemLockCoordinator = {
  withItemLock: (_itemId, fn) => fn(),
}

type TrpcProcedure = (input: any, options?: { signal?: AbortSignal }) => unknown

/**
 * Replaces the vault tRPC clients (`getVaultTrpcClient` and `getUntrackedVaultTrpcClient`) for the
 * current test with a fake whose sync procedures call the given functions with their input and
 * options. Call it in `beforeEach`.
 */
export function spyOnVaultTrpc(procedures: {
  pollSync?: TrpcProcedure
  putSnapshots?: TrpcProcedure
  fetchManifest?: TrpcProcedure
  fetchSnapshotsByIds?: TrpcProcedure
}): void {
  const notMocked = (name: string) => async () => {
    throw new Error(`tRPC procedure ${name} is not mocked in this test`)
  }
  const client = {
    sync: {
      pollSync: { mutate: procedures.pollSync ?? notMocked('sync.pollSync') },
    },
    items: {
      putSnapshots: { mutate: procedures.putSnapshots ?? notMocked('items.putSnapshots') },
      fetchManifest: { query: procedures.fetchManifest ?? notMocked('items.fetchManifest') },
      fetchSnapshotsByIds: { query: procedures.fetchSnapshotsByIds ?? notMocked('items.fetchSnapshotsByIds') },
    },
  } as unknown as ReturnType<typeof vaultTrpcClientModule.getVaultTrpcClient>
  spyOnExports(vaultTrpcClientModule, {
    getVaultTrpcClient: () => client,
    getUntrackedVaultTrpcClient: () => client,
  })
}

/** Creates an IndexedDB database with one object store, then closes it */
export async function createDatabase(factory: IDBFactory, name: string, storeName = 'store'): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

/** The names of the factory's databases */
export async function listDatabases(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).map(db => db.name ?? '')
}

/** Sets some of an item's tracked timestamps directly */
export function setTimestamps(tracker: SnapshotTracker, itemId: string, timestamps: Partial<ItemSyncTimestamps>): void {
  const byItemId = tracker['timestampsByItemId']
  byItemId.set(itemId as ItemId, { ...byItemId.get(itemId as ItemId), ...timestamps })
}

/** An item's tracked timestamps, empty if it has none */
export function getTimestamps(tracker: SnapshotTracker, itemId: string): Partial<ItemSyncTimestamps> {
  return tracker['timestampsByItemId'].get(itemId as ItemId) ?? {}
}

/** A realtime bus that records what's published and lets a test deliver other tabs' messages */
export interface FakeRealtimeBus {
  bus: RealtimeBus
  publishSyncPing: Mock<(itemIds: ItemId[]) => void>
  publishItemDirty: Mock<(itemIds: ItemId[]) => void>
  publishIndexUpdated: Mock<(itemIds: ItemId[]) => void>
  publishMetadataUpdated: Mock<(metadata: VaultMetadata) => void>
  close: Mock<() => void>
  /** Delivers messages as if another tab had published them */
  receiveSyncPing(itemIds: ItemId[]): void
  receiveItemDirty(itemIds: ItemId[]): void
  receiveIndexUpdated(itemIds: ItemId[]): void
  receiveMetadataUpdated(metadata: VaultMetadata): void
}

export function createFakeRealtimeBus(): FakeRealtimeBus {
  const syncPing = new Set<(itemIds: ItemId[]) => void>()
  const itemDirty = new Set<(itemIds: ItemId[]) => void>()
  const index = new Set<(itemIds: ItemId[]) => void>()
  const metadata = new Set<(metadata: VaultMetadata) => void>()
  const subscribe = <T>(listeners: Set<T>) => (listener: T) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const fake = {
    publishSyncPing: vi.fn(),
    publishItemDirty: vi.fn(),
    publishIndexUpdated: vi.fn(),
    publishMetadataUpdated: vi.fn(),
    close: vi.fn(() => {
      syncPing.clear()
      itemDirty.clear()
      index.clear()
      metadata.clear()
    }),
    receiveSyncPing: (itemIds: ItemId[]) => syncPing.forEach(listener => listener(itemIds)),
    receiveItemDirty: (itemIds: ItemId[]) => itemDirty.forEach(listener => listener(itemIds)),
    receiveIndexUpdated: (itemIds: ItemId[]) => index.forEach(listener => listener(itemIds)),
    receiveMetadataUpdated: (value: VaultMetadata) => metadata.forEach(listener => listener(value)),
  }
  const bus = {
    ...fake,
    subscribeSyncPing: subscribe(syncPing),
    subscribeItemDirty: subscribe(itemDirty),
    subscribeIndexUpdated: subscribe(index),
    subscribeMetadataUpdated: subscribe(metadata),
  } as unknown as RealtimeBus
  return { ...fake, bus }
}
