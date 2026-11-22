import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { Keyring } from '../../keys/Keyring'
import { generateVaultKey } from '../../keys/crypto'
import { clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'
import { ClientEventHub } from '../SyncEventHub'
import { SyncOrchestrator } from '../SyncOrchestrator'
import { SyncWorkerContext, type SyncWorkerContextConfig } from '../SyncWorkerContext'
import type { VaultDoc } from '../../shared/types'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from '../stores/syncMetadataStorage'
import { importItemSyncRecords } from '../stores/itemSyncRecords'
import { createMockLocalForagePool, mockLocalForage, type MockLocalForagePool } from './testUtils'
import { fence, installCrashFence, unfence } from './crashFence'
import { createSyncApiClient, type VaultServerBackend } from './vaultServers'

/** A new account's keyring, which starts at v2 (v1 is left for keys that may be password-derived) */
export async function createAccountKeys(): Promise<Keyring> {
  const keyring = new Keyring()
  keyring.replace(new Map([['2', await generateVaultKey()]]), '2')
  return keyring
}

/**
 * Gives a test its own local storage, in which devices are kept apart by their names. Device names
 * must not contain one another, since a crash fences storage by name.
 */
export function installLocalStorage(): MockLocalForagePool {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  clearAccountStoreInstancesCacheForTesting()
  const pool = createMockLocalForagePool()
  mockLocalForage(pool.createInstance)
  installCrashFence(pool)
  // Polls run when a test says so, so that it can decide what each device has seen. Coming back
  // online would otherwise start one alongside the test's own, and both would push the same change.
  vi.spyOn(SyncOrchestrator.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(SyncOrchestrator.prototype, 'flush').mockImplementation(() => {})
  vi.spyOn(SyncOrchestrator.prototype, 'onOnlineStateChange').mockImplementation(() => {})
  return pool
}

export interface DeviceOptions {
  isLeader?: boolean
  config?: Partial<SyncWorkerContextConfig>
}

/**
 * A real sync engine (everything `SyncWorkerContext` builds) on its own local storage, with the real
 * API client. Devices use the name as the account ID to keep their storage apart, and the fake
 * server ignores the account.
 */
export class Device {
  context!: SyncWorkerContext

  constructor(
    readonly name: string,
    private readonly server: VaultServerBackend,
    private readonly keys: Keyring,
    private readonly options: DeviceOptions = {},
  ) {}

  get services() {
    return this.context.services
  }

  async start(): Promise<this> {
    this.context = new SyncWorkerContext({
      accountId: this.name,
      clientEventHub: new ClientEventHub(),
      apiClient: createSyncApiClient(this.server),
      keys: this.keys,
      ...this.options.config,
    })
    await this.context.initialize()
    if (this.options.isLeader !== false) {
      this.context.session.setLeader(true)
    }
    return this
  }

  async stop(): Promise<void> {
    await this.context.shutdown()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /**
   * Stops the device as a dying tab does: nothing it hasn't stored yet reaches its storage, including
   * whatever `inFlight` (an operation it was in the middle of) goes on to write. `start` brings it back
   * on whatever it had stored.
   */
  async crash(inFlight?: Promise<unknown>): Promise<void> {
    fence(this.name)
    try {
      await this.context.shutdown()
    } catch {
      // Its writes fail now, which is all a crash needs of it
    }
    try {
      await inFlight
    } catch {
      // As above
    } finally {
      unfence(this.name)
    }
  }

  get isOnline(): boolean {
    return this.context.session.isOnline
  }

  setOnline(isOnline: boolean): void {
    this.context.setOnlineState(isOnline)
  }

  /** The heads of the item's doc, or null when this device has none */
  async heads(id: ItemId): Promise<string[] | null> {
    return this.services.docStore.readHeads(id)
  }

  async liveIds(): Promise<ItemId[]> {
    return this.services.indexManager.listItemIds()
  }

  async tombstoneIds(): Promise<ItemId[]> {
    return this.services.indexManager.listTombstoneIds()
  }

  /** Writes these items' docs to storage now, rather than on the Repo's throttle */
  async flushDocs(ids: ItemId[]): Promise<void> {
    await this.services.docStore.flushToStorage(ids)
  }

  /** The items this device has set aside for manual recovery */
  async quarantined(): Promise<ItemId[]> {
    return (await this.services.recoveryManager.listRecoveryItems()).map(entry => entry.itemId)
  }

  /** Takes this device back to how the old build left it, whose sync state can't be trusted */
  async rewindToOldBuild(oldHeads: [ItemId, string[]][] = []): Promise<void> {
    await this.stop()
    const storage = getSyncMetadataStorage(this.name)
    await storage.removeItem(SYNC_METADATA_KEYS.FIRST_START_RESET)
    await storage.removeItem(SYNC_METADATA_KEYS.FIRST_START_SYNCED)
    await storage.removeItem(SYNC_METADATA_KEYS.WAL_CLEARED)
    await storage.removeItem(SYNC_METADATA_KEYS.LOG_CURSOR)
    await storage.removeItem(SYNC_METADATA_KEYS.LOG_LAST_PULL_AT)
    await importItemSyncRecords(this.name, oldHeads.map(([itemId, serverHeads]) => ({ itemId, serverHeads })))
  }

  async create(id: string, fields: Record<string, unknown> = {}): Promise<ItemId> {
    await this.services.itemOperations.createItem({ id, type: 'note', ...fields } as unknown as VaultDoc)
    return id as ItemId
  }

  async edit(id: ItemId, changes: Record<string, unknown>): Promise<void> {
    await this.services.itemOperations.mutateItem(id, changes as Partial<VaultDoc>)
  }

  async read(id: ItemId): Promise<Record<string, unknown> | null> {
    return this.services.docStore.getAutomergeItem(id) as Promise<Record<string, unknown> | null>
  }

  /** Waits for the writes that marking an edit pending started */
  async settle(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  async poll(): Promise<string> {
    await this.settle()
    return this.services.poller.executePoll()
  }

  async uploadSnapshots(): Promise<void> {
    await this.settle()
    await this.services.snapshotManager.flushPendingSnapshots()
  }

  /** A poll whose manifest phase syncs now, whenever the last sync ran */
  async manifestSync(): Promise<void> {
    const { manifestSyncManager } = this.services
    const ticket = manifestSyncManager.openTicket('now')
    try {
      await this.poll()
    } finally {
      manifestSyncManager.closeTicket(ticket)
    }
  }

  /** Everything a device does in a normal stretch of being online */
  async sync(): Promise<void> {
    await this.poll()
    await this.uploadSnapshots()
    await this.poll()
  }

  async pending(): Promise<ItemId[]> {
    return this.services.changeOutbox.listPending()
  }
}
