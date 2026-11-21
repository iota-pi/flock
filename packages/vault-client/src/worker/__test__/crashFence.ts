import { IDBObjectStore } from 'fake-indexeddb'
import type { MockLocalForagePool } from './testUtils'

/**
 * Stops a device's writes reaching its local storage, as they stop when its tab dies. Every per-account
 * name (IndexedDB databases and localforage stores) has the account ID appended, so a write belongs to
 * a fenced device when its database name contains that device's account ID. Device names must not
 * contain one another.
 */
const fenced = new Set<string>()
/** Each fenced localforage store's real data, while its writes go to a copy that's thrown away */
const realData = new Map<string, Map<string, unknown>>()
let pool: MockLocalForagePool | undefined

function isFenced(databaseName: string): boolean {
  for (const accountId of fenced) {
    if (databaseName.includes(accountId)) return true
  }
  return false
}

const WRITE_METHODS = ['put', 'add', 'delete', 'clear'] as const

/** Installs the fence on the realm's fake IndexedDB, and on the localforage stores in `localForagePool` */
export function installCrashFence(localForagePool: MockLocalForagePool): void {
  pool = localForagePool
  fenced.clear()
  realData.clear()
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const method of WRITE_METHODS) {
    // Installed once per test: `restoreMocks` takes the spies off between tests
    if (vi.isMockFunction(proto[method])) continue
    const original = proto[method]
    vi.spyOn(proto, method).mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
      if (isFenced(this.transaction.db.name)) {
        throw new DOMException('The device crashed', 'AbortError')
      }
      return original.apply(this, args)
    })
  }
}

/** From now on, the device's writes are lost */
export function fence(accountId: string): void {
  if (!pool) throw new Error('installCrashFence first')
  if (fenced.has(accountId)) return
  fenced.add(accountId)
  for (const [key, instance] of pool.instances) {
    if (!key.includes(accountId)) continue
    realData.set(key, instance.data)
    instance.data = new Map(instance.data)
  }
}

/** The device's storage is as it was when it was fenced, and takes writes again */
export function unfence(accountId: string): void {
  if (!pool) throw new Error('installCrashFence first')
  fenced.delete(accountId)
  for (const [key, data] of realData) {
    if (!key.includes(accountId)) continue
    const instance = pool.instances.get(key)
    if (instance) instance.data = data
    realData.delete(key)
  }
}
