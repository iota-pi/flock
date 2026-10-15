import {
  MockLocalforage,
  createMockLocalForage,
  createMockLocalForagePool,
  createMockVault,
  createTestEventHubs,
} from './testUtils'

describe('testUtils', () => {
  describe('MockLocalforage and createMockLocalForage', () => {
    it('supports basic CRUD operations with getItem, setItem, removeItem, clear', async () => {
      const store = createMockLocalForage()
      expect(await store.getItem('key1')).toBeNull()

      await store.setItem('key1', 'val1')
      expect(await store.getItem('key1')).toBe('val1')
      expect(await store.length()).toBe(1)
      expect(await store.keys()).toEqual(['key1'])

      await store.removeItem('key1')
      expect(await store.getItem('key1')).toBeNull()
      expect(await store.length()).toBe(0)

      await store.setItem('key2', 'val2')
      await store.clear()
      expect(await store.getItem('key2')).toBeNull()
      expect(await store.length()).toBe(0)
    })

    it('supports initialization with entries array, map, or record', async () => {
      const storeWithEntries = createMockLocalForage([['k1', 'v1'], ['k2', 'v2']])
      expect(await storeWithEntries.getItem('k1')).toBe('v1')
      expect(await storeWithEntries.getItem('k2')).toBe('v2')

      const storeWithMap = createMockLocalForage(new Map([['k3', 'v3']]))
      expect(await storeWithMap.getItem('k3')).toBe('v3')

      const storeWithRecord = createMockLocalForage({ k4: 'v4' })
      expect(await storeWithRecord.getItem('k4')).toBe('v4')
    })

    it('supports initialization with config and initial data', async () => {
      const store = createMockLocalForage({ name: 'my-db', storeName: 'my-store' }, { k: 'v' })
      expect(store.config).toEqual({ name: 'my-db', storeName: 'my-store' })
      expect(store._config).toEqual({ name: 'my-db', storeName: 'my-store' })
      expect(await store.getItem('k')).toBe('v')
    })

    it('aliases data and store properties', async () => {
      const store = new MockLocalforage()
      expect(store.store).toBe(store.data)
      store.data.set('a', 123)
      expect(store.store.get('a')).toBe(123)
    })

    it('supports iterate with early break on return', async () => {
      const store = createMockLocalForage([['a', 1], ['b', 2], ['c', 3]])
      const iterated: [string, any][] = []
      const res = await store.iterate((val: any, key: string) => {
        iterated.push([key, val])
        if (key === 'b') return 'stopped'
      })
      expect(res).toBe('stopped')
      expect(iterated).toEqual([['a', 1], ['b', 2]])
    })

    it('resets data and mock histories with reset()', async () => {
      const store = createMockLocalForage({ a: 1 })
      await store.getItem('a')
      expect(store.getItem).toHaveBeenCalled()

      store.reset()
      expect(await store.length()).toBe(0)
      expect(store.getItem).not.toHaveBeenCalled()
    })
  })

  describe('createMockLocalForagePool', () => {
    it('creates or reuses instances by name#storeName', () => {
      const pool = createMockLocalForagePool()
      const s1 = pool.createInstance({ name: 'db1', storeName: 'table1' })
      const s2 = pool.createInstance({ name: 'db1', storeName: 'table1' })
      const s3 = pool.createInstance({ name: 'db1', storeName: 'table2' })

      expect(s1).toBe(s2)
      expect(s1).not.toBe(s3)
      expect(pool.getInstance('db1', 'table1')).toBe(s1)
      expect(pool.getInstance('db1', 'table2')).toBe(s3)

      pool.reset()
      expect(pool.instances.size).toBe(0)
    })
  })

  describe('createMockVault', () => {
    it('provides sensible default behaviors for crypto methods', async () => {
      const vault = createMockVault()

      expect(vault.hasVaultKey('1')).toBe(true)
      expect(await vault.waitForKeyVersion('1')).toBe(true)

      const decryptedBytes = await vault.decryptBytes({ cipher: new Uint8Array([5, 6, 7]) })
      expect(decryptedBytes).toEqual(new Uint8Array([5, 6, 7]))

      const decryptedString = await vault.decryptBytes({ cipher: 'test-cipher' })
      expect(decryptedString).toBe('test-cipher')

      const encrypted = await vault.encryptBytes(new Uint8Array([1, 2]))
      expect(encrypted).toEqual({
        iv: 'mock-iv',
        cipher: 'mock-cipher-2',
        kver: '1',
      })

      const decryptedObj = await vault.decryptObject({ cipher: JSON.stringify({ hello: 'world' }) })
      expect(decryptedObj).toEqual({ hello: 'world' })
    })

    it('resets mocks with reset()', async () => {
      const vault = createMockVault()
      vault.hasVaultKey.mockReturnValue(false)
      expect(vault.hasVaultKey('1')).toBe(false)

      vault.reset()
      expect(vault.hasVaultKey('1')).toBe(true)
    })
  })

  describe('createTestEventHubs', () => {
    it('instantiates clientEventHub and internalEventHub', () => {
      const { clientEventHub, internalEventHub } = createTestEventHubs()
      expect(clientEventHub).toBeDefined()
      expect(internalEventHub).toBeDefined()

      const clientSpy = vi.fn()
      clientEventHub.subscribe(clientSpy)
      clientEventHub.emit({ type: 'ready' })
      expect(clientSpy).toHaveBeenCalledWith({ type: 'ready' })

      const internalSpy = vi.fn()
      internalEventHub.subscribe(internalSpy)
      internalEventHub.emit({ type: 'soleLeaderRestored' })
      expect(internalSpy).toHaveBeenCalledWith({ type: 'soleLeaderRestored' })
    })
  })
})
