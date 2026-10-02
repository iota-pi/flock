import type { Mock } from 'vitest'
import { ClientEventHub, WorkerInternalEventHub } from '../SyncEventHub'

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

export interface TestEventHubs {
  clientEventHub: ClientEventHub
  internalEventHub: WorkerInternalEventHub
}

/**
 * Instantiates both a fresh ClientEventHub and WorkerInternalEventHub for testing.
 */
export function createTestEventHubs(): TestEventHubs {
  return {
    clientEventHub: new ClientEventHub(),
    internalEventHub: new WorkerInternalEventHub(),
  }
}
