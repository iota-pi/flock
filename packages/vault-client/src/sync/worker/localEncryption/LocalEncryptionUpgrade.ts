import type { StorageKey } from '@automerge/automerge-repo/slim'
import { VaultIndexedDBStorageAdapter } from '../VaultIndexedDBStorageAdapter'
import { getAutomergeDBName } from '../AutomergeRepoManager'
import { SyncWriteAheadLog } from '../SyncWriteAheadLog'
import { WorkerInternalEventHub } from '../SyncEventHub'
import { IndexStore } from '../stores/IndexStore'
import { mergeIndexDocuments } from '../docStore/AutomergeIndexManager'
import { getAccountDatabaseName } from '../../shared/createAccountStore'
import { databaseExists as defaultDatabaseExists } from '../../utils/databaseExists'
import { retireLegacyStores as defaultRetireLegacyStores, type RetireLegacyStoresOptions } from './retireLegacyStores'
import type { LocalCipher } from './LocalCipher'

/** Set in the sealed database's `meta` store once a device's plaintext data has first been copied */
export const UPGRADED_AT_KEY = 'upgradedAt'

const PAGE_SIZE = 200
const STORAGE_ADAPTER_ID_KEY: StorageKey = ['storage-adapter-id']

export interface LocalEncryptionUpgradeDeps {
  accountId: string
  sealed: VaultIndexedDBStorageAdapter
  cipher: LocalCipher
  /** Asks other tabs to stop syncing the account before the plaintext stores are deleted */
  onRetiring?: () => void
  databaseExists?: (name: string) => Promise<boolean>
  retireLegacyStores?: (options: RetireLegacyStoresOptions) => Promise<boolean>
}

/**
 * Copies a device's plaintext local data into the sealed stores, then retires the plaintext stores.
 * Runs at every start, under the account's local data lock: it costs a couple of existence checks once
 * nothing plaintext is left, and merges in anything an old build's tab has written since.
 *
 * Every step is idempotent, so a crash at any point resumes at the next start:
 * - Automerge chunks are keyed by content hash, so copying one again writes the same bytes.
 * - WAL entries keep their IDs, and ones already copied are skipped.
 * - The index is merged, never replaced.
 */
export class LocalEncryptionUpgrade {
  private readonly databaseExists: (name: string) => Promise<boolean>
  private readonly retireLegacyStores: (options: RetireLegacyStoresOptions) => Promise<boolean>

  constructor(private readonly deps: LocalEncryptionUpgradeDeps) {
    this.databaseExists = deps.databaseExists ?? defaultDatabaseExists
    this.retireLegacyStores = deps.retireLegacyStores ?? defaultRetireLegacyStores
  }

  /** Returns whether the device is left with no plaintext stores */
  async run(): Promise<{ retired: boolean }> {
    const { accountId, sealed } = this.deps
    const hasAutomerge = await this.databaseExists(getAutomergeDBName(accountId))
    const hasWal = await this.databaseExists(getAccountDatabaseName('wal-entries', accountId))
    const plaintextIndex = await new IndexStore(accountId).getIndex()

    if (hasAutomerge) await this.copyChunks()
    if (hasWal) await this.copyWal()
    if (plaintextIndex) await this.mergeIndex()
    if ((await sealed.getMeta(UPGRADED_AT_KEY)) === undefined) {
      await sealed.putMeta(UPGRADED_AT_KEY, Date.now())
    }

    if (!hasAutomerge && !hasWal && !plaintextIndex) return { retired: true }
    const retired = await this.retireLegacyStores({ accountId, onRetiring: this.deps.onRetiring })
    return { retired }
  }

  /**
   * Copies document chunks. `sync-state` records are left behind: they're per peer rather than by
   * content, so a copy could overwrite newer state, and the sync protocol rebuilds them.
   */
  private async copyChunks(): Promise<void> {
    const { sealed } = this.deps
    const plaintext = new VaultIndexedDBStorageAdapter(getAutomergeDBName(this.deps.accountId))
    try {
      const hasStorageId = await sealed.has(STORAGE_ADAPTER_ID_KEY)
      let after: StorageKey | undefined
      while (true) {
        const page = await plaintext.loadPage(after, PAGE_SIZE)
        if (page.length === 0) break
        const toCopy = page.filter(chunk => {
          if (!chunk.data) return false
          const kind = chunk.key[1]
          if (kind === 'snapshot' || kind === 'incremental') return true
          // Keeps the Repo's storage ID, which other tabs' sync states refer to, on the first copy only
          return !hasStorageId && chunk.key.length === 1 && chunk.key[0] === STORAGE_ADAPTER_ID_KEY[0]
        })
        await Promise.all(toCopy.map(chunk => sealed.save(chunk.key, chunk.data!)))
        after = page[page.length - 1].key
      }
    } finally {
      await plaintext.close()
    }
  }

  /** Copies the plaintext WAL, which may hold changes no snapshot carries yet */
  private async copyWal(): Promise<void> {
    const { accountId, cipher } = this.deps
    // Runs before the session's components exist, so nothing listens for the WAL's events yet
    const eventHub = new WorkerInternalEventHub()
    const byItem = await new SyncWriteAheadLog(accountId, eventHub).readAll()
    const entries = Array.from(byItem.values()).flat()
    if (entries.length === 0) return
    await new SyncWriteAheadLog(accountId, eventHub, { cipher }).importEntries(entries)
  }

  /**
   * Merges the plaintext index into the sealed one. On a re-import (an old build's tab wrote to the
   * plaintext stores since), deletions from either side hold and the sealed side's settings win.
   */
  private async mergeIndex(): Promise<void> {
    const { accountId, cipher } = this.deps
    const plaintext = await new IndexStore(accountId).getIndex()
    if (!plaintext) return
    const sealedStore = new IndexStore(accountId, { cipher })
    const current = await sealedStore.getIndex()
    const merged = current
      ? mergeIndexDocuments(current, plaintext, { tombstonesWin: true, metadata: 'local' })
      : plaintext
    await sealedStore.saveIndex(merged)
  }
}
