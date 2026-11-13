import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { FetchedItem, ItemId, ManifestEntry, SyncLogEntry, SyncLogMessage, VaultSnapshotInput } from '@vault/shared'
import { Keyring } from '../../keys/Keyring'
import { generateVaultKey } from '../../keys/crypto'
import { clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'
import { ClientEventHub } from '../SyncEventHub'
import { SyncOrchestrator } from '../SyncOrchestrator'
import { SyncWorkerContext, type SyncWorkerContextConfig } from '../SyncWorkerContext'
import type { SyncApiClient } from '../SyncApiClient'
import type { VaultDoc } from '../../shared/types'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from '../stores/syncMetadataStorage'
import { createMockLocalForagePool, mockLocalForage } from './testUtils'

const PAGE_SIZE = 200

interface ServerItem {
  version: number
  snapshot?: VaultSnapshotInput['snapshot']
  heads?: VaultSnapshotInput['heads']
  deleted: boolean
  modifiedAt: number
}

/** The vault server, as far as the sync engine can tell: a blind relay with one ordered log */
export class FakeVaultServer {
  rows: SyncLogEntry[] = []
  readonly items = new Map<ItemId, ServerItem>()
  /** Rows a read can't see yet, like the part of a transaction that isn't visible */
  readonly hiddenSeqs = new Set<number>()
  head = 0
  /** Set to make every request fail, as it does while the server can't be reached */
  isDown = false
  clock = () => Date.now()

  private checkUp(): void {
    if (this.isDown) throw new TypeError('Failed to fetch')
  }

  pollLog(input: { push?: SyncLogMessage[]; after: number }) {
    this.checkUp()
    const pushResults = (input.push ?? []).map(({ itemId, encryptedMessage }) => {
      this.head += 1
      this.rows.push({ seq: this.head, itemId, encryptedMessage, createdAt: this.clock() })
      return { itemId, seq: this.head }
    })
    const visible = this.rows.filter(row => row.seq > input.after && !this.hiddenSeqs.has(row.seq))
    return {
      pushResults,
      entries: visible.slice(0, PAGE_SIZE),
      hasMore: visible.length > PAGE_SIZE,
      serverNow: this.clock(),
    }
  }

  putSnapshots(input: { snapshots: VaultSnapshotInput[] }) {
    this.checkUp()
    const results = input.snapshots.map(snapshot => {
      const existing = this.items.get(snapshot.itemId)
      const version = (existing?.version ?? 0) + 1
      this.items.set(snapshot.itemId, {
        version,
        snapshot: snapshot.snapshot ?? existing?.snapshot,
        heads: snapshot.heads,
        deleted: existing?.deleted === true || snapshot.deleted === true,
        modifiedAt: snapshot.modified,
      })
      return { itemId: snapshot.itemId, version }
    })
    return { success: true, persisted: results.length, total: results.length, results, logSeq: this.head }
  }

  fetchManifest() {
    this.checkUp()
    const manifest: ManifestEntry[] = Array.from(this.items.entries()).map(([itemId, item]) => ({
      itemId,
      version: item.version,
      modifiedAt: item.modifiedAt,
      ...(item.deleted ? { isDeleted: true } : {}),
      ...(item.heads && !item.deleted ? { heads: item.heads } : {}),
    }))
    return { manifest, serverTime: this.clock() }
  }

  fetchSnapshotsByIds(input: { itemIds: ItemId[] }) {
    this.checkUp()
    const items = input.itemIds.flatMap(itemId => {
      const item = this.items.get(itemId)
      if (!item) return []
      return [{
        item: itemId,
        version: item.version,
        modified: item.modifiedAt,
        snapshot: item.snapshot,
        ...(item.deleted ? { metadata: { deleted: true } } : {}),
      } as unknown as FetchedItem]
    })
    return { items, serverTime: this.clock() }
  }

  /** Empties the log, as the TTL eventually does */
  expireLog(throughSeq = this.head): void {
    this.rows = this.rows.filter(row => row.seq > throughSeq)
  }

  loseRow(seq: number): void {
    this.rows = this.rows.filter(row => row.seq !== seq)
  }
}

function createApiClient(server: FakeVaultServer): SyncApiClient {
  return {
    getValidToken: async () => 'token',
    executeWithAuth: <T>(operation: () => Promise<T>) => operation(),
    pollLog: async (input: { push?: SyncLogMessage[]; after: number }) => server.pollLog(input),
    putSnapshots: async (input: { snapshots: VaultSnapshotInput[] }) => server.putSnapshots(input),
    fetchManifest: async () => server.fetchManifest(),
    fetchSnapshotsByIds: async (input: { itemIds: ItemId[] }) => server.fetchSnapshotsByIds(input),
    raiseDataVersion: async () => ({ dataVersion: 0, blockers: [] }),
  } as unknown as SyncApiClient
}

/** The account's keys, which every device holds */
/** A new account's keyring, which starts at v2 (v1 is left for keys that may be password-derived) */
export async function createAccountKeys(): Promise<Keyring> {
  const keyring = new Keyring()
  keyring.replace(new Map([['2', await generateVaultKey()]]), '2')
  return keyring
}

/** Gives a test its own local storage, in which devices are kept apart by their names */
export function installLocalStorage(): void {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  clearAccountStoreInstancesCacheForTesting()
  mockLocalForage(createMockLocalForagePool().createInstance)
  // Polls run when a test says so, so that it can decide what each device has seen
  vi.spyOn(SyncOrchestrator.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(SyncOrchestrator.prototype, 'flush').mockImplementation(() => {})
}

export interface DeviceOptions {
  isLeader?: boolean
  config?: Partial<SyncWorkerContextConfig>
}

/**
 * A real sync engine (everything `SyncWorkerContext` builds) on its own local storage. Devices use
 * the name as the account ID to keep their storage apart, and the server ignores the account.
 */
export class Device {
  context!: SyncWorkerContext

  constructor(
    readonly name: string,
    private readonly server: FakeVaultServer,
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
      apiClient: createApiClient(this.server),
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

  /** Takes this device back to how the old build left it, whose sync state can't be trusted */
  async rewindToOldBuild(oldHeads: [ItemId, string[]][] = []): Promise<void> {
    await this.stop()
    const storage = getSyncMetadataStorage(this.name)
    await storage.removeItem(SYNC_METADATA_KEYS.FIRST_START_RESET)
    await storage.removeItem(SYNC_METADATA_KEYS.FIRST_START_SYNCED)
    await storage.removeItem(SYNC_METADATA_KEYS.WAL_CLEARED)
    await storage.removeItem(SYNC_METADATA_KEYS.LOG_CURSOR)
    await storage.removeItem(SYNC_METADATA_KEYS.LOG_LAST_PULL_AT)
    await storage.setItem(SYNC_METADATA_KEYS.SYNCED_HEADS, oldHeads)
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

  /** A manifest sync now, whenever the last one ran */
  async manifestSync(): Promise<void> {
    await this.services.manifestSyncManager.syncNow()
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
