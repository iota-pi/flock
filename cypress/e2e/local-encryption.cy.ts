/**
 * Acceptance test for encryption at rest (docs/local-encryption.md, Part 2): once sync has stopped,
 * nothing a person typed can be found anywhere the app stores data on the device.
 *
 * A byte search only proves this if unencrypted chunks would contain the text. Automerge compresses
 * larger columns, so `src/app/vault/localEncryptionControl.spec.ts` checks that a short name like this
 * one appears verbatim in Automerge's saved chunks.
 */

const encoder = new TextEncoder()

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** Whether any string or byte array inside a stored value contains `text` */
function valueContains(value: unknown, text: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(text)
  if (value instanceof Uint8Array) return containsBytes(value, encoder.encode(text))
  if (value instanceof ArrayBuffer) return containsBytes(new Uint8Array(value), encoder.encode(text))
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Object.values(value as Record<string, unknown>).some(child => valueContains(child, text, seen))
}

type StoredRecord = { database: string, store: string, key: IDBValidKey, value: unknown }

function readAllRecords(win: Window): Promise<StoredRecord[]> {
  return win.indexedDB.databases().then(databases => Promise.all(databases.map(({ name }) => (
    new Promise<StoredRecord[]>((resolve, reject) => {
      const request = win.indexedDB.open(name!)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const storeNames = Array.from(db.objectStoreNames)
        if (storeNames.length === 0) {
          db.close()
          resolve([])
          return
        }
        const records: StoredRecord[] = []
        const transaction = db.transaction(storeNames, 'readonly')
        for (const store of storeNames) {
          const cursorRequest = transaction.objectStore(store).openCursor()
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) return
            records.push({ database: name!, store, key: cursor.key, value: cursor.value })
            cursor.continue()
          }
        }
        transaction.oncomplete = () => {
          db.close()
          resolve(records)
        }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  )))).then(perDatabase => perDatabase.flat())
}

async function cacheStorageContains(win: Window, text: string): Promise<string[]> {
  const found: string[] = []
  for (const cacheName of await win.caches.keys()) {
    const cache = await win.caches.open(cacheName)
    for (const request of await cache.keys()) {
      const response = await cache.match(request)
      if (response && (await response.text()).includes(text)) found.push(request.url)
    }
  }
  return found
}

function readAccount(win: Window): string {
  return JSON.parse(win.localStorage.getItem('FlockVaultMeta') ?? '{}').account as string
}

/** The wrapped device storage key, from the sealed database's `meta` store */
function readDeviceKeyWrap(win: Window, account: string): Promise<{ kver: string } | undefined> {
  return new Promise((resolve, reject) => {
    const request = win.indexedDB.open(`flock-automerge-sealed-${account}`)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('meta', 'readonly').objectStore('meta').get('dsk')
      get.onsuccess = () => {
        db.close()
        resolve(get.result)
      }
      get.onerror = () => reject(get.error)
    }
  })
}

function deleteDeviceKeyWrap(win: Window, account: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = win.indexedDB.open(`flock-automerge-sealed-${account}`)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('meta', 'readwrite')
      transaction.objectStore('meta').delete('dsk')
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

describe('Local encryption', () => {
  it('moves the device key to the new data key when the vault is re-encrypted', () => {
    cy.createPerson({ name: `Merry_${Date.now().toString().slice(-6)}` })

    cy.window().then({ timeout: 60000 }, async (win: any) => {
      const account = readAccount(win)
      const before = await readDeviceKeyWrap(win, account)
      const [vault, bridge] = await Promise.all([win.vault, win.syncBridge])

      await vault.reencryptAllItems(bridge, account)

      const after = await readDeviceKeyWrap(win, account)
      expect(before?.kver, 'key version before').to.be.a('string')
      expect(after?.kver, 'key version after').to.be.a('string').and.not.equal(before?.kver)
    })
  })

  it('offers to download the data again when the device key is lost, and only discards on confirmation', () => {
    const name = `Samwise_${Date.now().toString().slice(-6)}`
    cy.createPerson({ name }, true).saveDrawer()
    cy.contains(name).should('exist')

    // The person must be on the server before this device's copy is discarded
    cy.window().then({ timeout: 60000 }, async (win: any) => {
      const bridge = await win.syncBridge
      await bridge.flushSync()
      await bridge.pushSnapshots()
      await bridge.shutdown({ clearLocalData: false })
      await deleteDeviceKeyWrap(win, readAccount(win))
      void bridge.initialize(readAccount(win)).catch(() => {})
    })

    cy.contains("This device's data can't be opened", { timeout: 60000 }).should('exist')
    cy.contains('button', 'Discard local data').click()
    cy.contains('button', 'Discard and download').should('exist')
    cy.contains('button', 'Discard and download').click()

    cy.contains("This device's data can't be opened").should('not.exist')
    cy.page('people')
    cy.contains(name, { timeout: 30000 }).should('exist')
    cy.window().then({ timeout: 30000 }, async win => {
      expect(await readDeviceKeyWrap(win, readAccount(win)), 'new device key').to.have.property('kver')
    })
  })

  it('leaves nothing a person typed readable on the device once sync has stopped', () => {
    const name = `Pippin_${Date.now().toString().slice(-6)}`
    cy.createPerson({ name }, true).saveDrawer()
    cy.contains(name).should('exist')

    // Shutting the worker down flushes every pending Automerge save to IndexedDB
    cy.window().then({ timeout: 30000 }, async (win: any) => {
      const bridge = await win.syncBridge
      await bridge.shutdown({ clearLocalData: false })
    })

    cy.window().then({ timeout: 30000 }, async win => {
      const account = JSON.parse(win.localStorage.getItem('FlockVaultMeta') ?? '{}').account as string
      expect(account, 'account id').to.be.a('string').and.not.be.empty
      const records = await readAllRecords(win)

      // The account's data is in the sealed databases, and nothing is left in the plaintext ones
      const sealedChunks = records.filter(r => r.database === `flock-automerge-sealed-${account}` && r.store === 'documents')
      expect(sealedChunks.length, 'sealed Automerge records').to.be.greaterThan(0)
      for (const record of sealedChunks) {
        expect(record.value, `sealed record ${String(record.key)}`).to.include.keys('v', 'iv', 'ct')
        expect(record.value).not.to.have.property('binary')
      }
      const dsk = records.find(r => r.database === `flock-automerge-sealed-${account}` && r.key === 'dsk')
      expect(dsk?.value, 'wrapped device key').to.include.keys('kver', 'iv', 'ct')
      expect(records.filter(r => r.database === `flock-automerge-db-${account}`), 'plaintext Automerge records').to.be.empty
      expect(records.filter(r => r.database === `FlockVault_SyncWAL_${account}`), 'plaintext WAL entries').to.be.empty
      expect(records.some(r => r.key === 'indexDoc'), 'plaintext index').to.equal(false)
      expect(records.some(r => r.key === 'indexDocSealed'), 'sealed index').to.equal(true)
      // The session token is kept only in memory
      expect(records.some(r => r.key === 'active_session_token'), 'stored session token').to.equal(false)

      // The name is nowhere: not in IndexedDB, localStorage or Cache Storage
      const leaks = records.filter(r => valueContains(r.value, name) || valueContains(r.key, name))
      expect(leaks.map(r => `${r.database}/${r.store}/${String(r.key)}`), 'IndexedDB records containing the name').to.be.empty
      const localStorageLeaks = Object.keys(win.localStorage).filter(key => (win.localStorage.getItem(key) ?? '').includes(name))
      expect(localStorageLeaks, 'localStorage keys containing the name').to.be.empty
      expect(await cacheStorageContains(win, name), 'Cache Storage entries containing the name').to.be.empty
    })
  })
})
