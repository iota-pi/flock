import { Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { AccountSettings, withSettingsDocPassthrough } from './AccountSettings'
import { AutomergeDocStore, type RepoDoc } from './docStore'
import { passthroughCodec, type DocCodec, type LegacySettingsSource } from './domain'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { VaultMetadata } from '../shared/types'
import { settingsDocId, type ItemId } from 'src/shared/vault/ids'

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('./realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: unknown[]) => mockPublishRealtimeBusSyncPing(...args),
}))

const SYNCED_KEYS = ['prayerGoal', 'defaultPrayerFrequency', 'completedMigrations']

/** In-memory index that reports metadata changes like AutomergeIndexManager's onMetadataUpdated callback */
function createIndexManager(initial: VaultMetadata = {}) {
  let metadata: VaultMetadata = { ...initial }
  const itemIds = new Set<ItemId>()
  const manager = {
    itemIds,
    onMetadataUpdated: (() => {}) as (metadata: VaultMetadata) => void,
    get metadata() {
      return metadata
    },
    getAutomergeMetadata: vi.fn(async () => ({ ...metadata })),
    updateAutomergeMetadata: vi.fn(async (changes: VaultMetadata) => {
      metadata = { ...metadata, ...changes }
      manager.onMetadataUpdated(metadata)
      return metadata
    }),
    removeMetadataKeys: vi.fn(async (keys: readonly string[]) => {
      metadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => !keys.includes(key)))
      manager.onMetadataUpdated(metadata)
    }),
    addAutomergeItemIdsToIndex: vi.fn(async (ids: ItemId[]) => {
      for (const id of ids) itemIds.add(id)
    }),
  }
  return manager
}

describe('AccountSettings', () => {
  let accountCounter = 0
  let accountId: string
  let docStore: AutomergeDocStore
  let indexManager: ReturnType<typeof createIndexManager>
  let emit: ReturnType<typeof vi.fn>
  let markDocumentDirty: ReturnType<typeof vi.fn<(itemId: ItemId) => void>>

  function createSettings(options: { legacySettings?: LegacySettingsSource; local?: VaultMetadata } = {}) {
    indexManager = createIndexManager(options.local)
    const settings = new AccountSettings({
      accountId,
      docStore,
      indexManager: indexManager as any,
      eventHub: { emit } as any,
      markDocumentDirty,
      syncedKeys: SYNCED_KEYS,
      legacySettings: options.legacySettings,
      withAuth: request => request(),
    })
    indexManager.onMetadataUpdated = metadata => settings.handleLocalMetadata(metadata)
    return settings
  }

  function lastEmittedMetadata(): VaultMetadata | undefined {
    const events = emit.mock.calls.map(([event]) => event).filter(event => event.type === 'metadataUpdated')
    return events.at(-1)?.metadata
  }

  async function readDoc(): Promise<RepoDoc | null> {
    return docStore.readItemSnapshot(settingsDocId(accountId))
  }

  beforeEach(() => {
    accountCounter += 1
    accountId = `account-${accountCounter}`
    docStore = new AutomergeDocStore(new Repo())
    emit = vi.fn()
    mockPublishRealtimeBusSyncPing.mockClear()
    markDocumentDirty = vi.fn<(itemId: ItemId) => void>()
  })

  it('uses a fixed ID derived from the account', () => {
    const settings = createSettings()
    expect(settings.docId).toBe(`settings-${accountId}`)
    expect(settings.isSettingsDoc(`settings-${accountId}`)).toBe(true)
    expect(settings.isSettingsDoc('settings-other')).toBe(false)
  })

  it('does not create the settings document until a synced setting is written', async () => {
    const settings = createSettings({ local: { sortCriteria: [] } })

    await settings.load()
    await settings.mutate({ sortCriteria: [{ type: 'name', reverse: false }] })

    expect(await readDoc()).toBeNull()
    expect(markDocumentDirty).not.toHaveBeenCalled()
    expect(lastEmittedMetadata()).toEqual({ sortCriteria: [{ type: 'name', reverse: false }] })
  })

  it('writes synced keys to the settings document and other keys to local metadata', async () => {
    const settings = createSettings()
    await settings.load()

    await settings.mutate({ prayerGoal: 5, sortCriteria: [{ type: 'name', reverse: true }] })

    expect(await readDoc()).toEqual({ prayerGoal: 5 })
    expect(indexManager.metadata).toEqual({ sortCriteria: [{ type: 'name', reverse: true }] })
    expect(indexManager.itemIds.has(settings.docId)).toBe(true)
    expect(markDocumentDirty).toHaveBeenCalledWith(settings.docId)
    expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith(accountId, [settings.docId])
    expect(settings.getMetadata()).toEqual({ prayerGoal: 5, sortCriteria: [{ type: 'name', reverse: true }] })
  })

  it('skips writes that would not change the settings document', async () => {
    const settings = createSettings()
    await settings.load()
    await settings.mutate({ prayerGoal: 5, defaultPrayerFrequency: { person: 'daily' } })
    markDocumentDirty.mockClear()
    const headsBefore = Automerge.getHeads((await readDoc()) as Automerge.Doc<RepoDoc>)

    await settings.mutate({ prayerGoal: 5, defaultPrayerFrequency: { person: 'daily' } })

    expect(markDocumentDirty).not.toHaveBeenCalled()
    expect(Automerge.getHeads((await readDoc()) as Automerge.Doc<RepoDoc>)).toEqual(headsBefore)
  })

  it('edits nested settings in place so concurrent edits to different fields merge', async () => {
    const settings = createSettings()
    await settings.load()
    await settings.mutate({ defaultPrayerFrequency: { person: 'daily', group: 'weekly' } })

    const handle = await docStore.findHandle(settings.docId)
    const otherDevice = Automerge.clone(handle!.doc()!)
    const otherDeviceEdited = Automerge.change(otherDevice, doc => {
      (doc.defaultPrayerFrequency as Record<string, string>).group = 'monthly'
    })

    // The app sends the whole object, changing only person
    await settings.mutate({ defaultPrayerFrequency: { person: 'weekly', group: 'weekly' } })
    handle!.update(doc => Automerge.merge(doc, otherDeviceEdited))

    expect((await readDoc())?.defaultPrayerFrequency).toEqual({ person: 'weekly', group: 'monthly' })
  })

  it('lets the settings document override legacy local values in the emitted metadata', async () => {
    const settings = createSettings({ local: { prayerGoal: 3, sortCriteria: [] } })
    await settings.load()
    expect(lastEmittedMetadata()).toEqual({ prayerGoal: 3, sortCriteria: [] })

    settings.handleSettingsDoc({ prayerGoal: 8, unrelated: true })

    expect(lastEmittedMetadata()).toEqual({ prayerGoal: 8, sortCriteria: [] })
  })

  it('still emits local metadata when the settings document cannot be read', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settings = createSettings({ local: { sortCriteria: [] } })
    vi.spyOn(docStore, 'readItemSnapshot').mockRejectedValueOnce(new Error('Storage error'))

    await settings.load()

    expect(lastEmittedMetadata()).toEqual({ sortCriteria: [] })
    warnSpy.mockRestore()
  })

  it('reports a failed write and re-emits the current metadata', async () => {
    const settings = createSettings({ local: { sortCriteria: [] } })
    await settings.load()
    indexManager.updateAutomergeMetadata.mockRejectedValueOnce(new Error('Storage failure'))

    await settings.mutate({ sortCriteria: [{ type: 'name', reverse: false }] })

    expect(emit).toHaveBeenCalledWith({ type: 'mutationFailed', mutationType: 'metadata', error: 'Storage failure' })
    expect(lastEmittedMetadata()).toEqual({ sortCriteria: [] })
  })

  describe('migrateLegacySettings', () => {
    it('moves synced keys from local metadata into the settings document', async () => {
      const settings = createSettings({ local: { prayerGoal: 4, sortCriteria: [] } })

      await settings.migrateLegacySettings()

      expect(await readDoc()).toEqual({ prayerGoal: 4 })
      expect(indexManager.metadata).toEqual({ sortCriteria: [] })
    })

    it('keeps values another device already migrated', async () => {
      const settings = createSettings({ local: { prayerGoal: 4 } })
      await settings.mutate({ prayerGoal: 9 })

      await settings.migrateLegacySettings()

      expect(await readDoc()).toEqual({ prayerGoal: 9 })
      expect(indexManager.metadata).toEqual({})
    })

    it('seeds missing keys from the legacy source, clears it, and removes obsolete local keys', async () => {
      const source: LegacySettingsSource = {
        load: vi.fn(async () => ({ prayerGoal: 6, defaultPrayerFrequency: { person: 'daily' }, deviceOnly: 1 })),
        clear: vi.fn(async () => undefined),
        obsoleteLocalKeys: ['updatedAt'],
      }
      const settings = createSettings({
        legacySettings: source,
        local: { prayerGoal: 2, updatedAt: 100, sortCriteria: [] },
      })
      await settings.mutate({ defaultPrayerFrequency: { person: 'weekly' } })

      await settings.migrateLegacySettings()

      expect(source.load).toHaveBeenCalledWith(
        { prayerGoal: 2, updatedAt: 100, sortCriteria: [] },
        expect.objectContaining({ accountId }),
      )
      expect(await readDoc()).toEqual({ prayerGoal: 6, defaultPrayerFrequency: { person: 'weekly' } })
      expect(source.clear).toHaveBeenCalledTimes(1)
      expect(indexManager.metadata).toEqual({ sortCriteria: [] })
    })

    it('does not clear the legacy source when it has nothing to migrate', async () => {
      const source: LegacySettingsSource = {
        load: vi.fn(async () => null),
        clear: vi.fn(async () => undefined),
      }
      const settings = createSettings({ legacySettings: source, local: { sortCriteria: [] } })

      await settings.migrateLegacySettings()

      expect(source.clear).not.toHaveBeenCalled()
      expect(await readDoc()).toBeNull()
      expect(indexManager.removeMetadataKeys).not.toHaveBeenCalled()
    })

    it('keeps local legacy keys when clearing fails, so the next sync retries', async () => {
      const source: LegacySettingsSource = {
        load: vi.fn(async () => ({ prayerGoal: 6 })),
        clear: vi.fn(async () => {
          throw new Error('Network error')
        }),
      }
      const settings = createSettings({ legacySettings: source, local: { prayerGoal: 6 } })

      await expect(settings.migrateLegacySettings()).rejects.toThrow('Network error')

      expect(await readDoc()).toEqual({ prayerGoal: 6 })
      expect(indexManager.metadata).toEqual({ prayerGoal: 6 })
    })

    it('does nothing when the app syncs no metadata keys', async () => {
      indexManager = createIndexManager({ prayerGoal: 4 })
      const settings = new AccountSettings({
        accountId,
        docStore,
        indexManager: indexManager as any,
        eventHub: { emit } as any,
        markDocumentDirty,
        withAuth: request => request(),
      })

      await settings.migrateLegacySettings()
      await settings.mutate({ prayerGoal: 7 })

      expect(await readDoc()).toBeNull()
      expect(indexManager.metadata).toEqual({ prayerGoal: 7 })
    })
  })
})

describe('withSettingsDocPassthrough', () => {
  const appCodec: DocCodec = {
    decode: (id, raw) => ({ ...raw, id, decoded: true }),
    isCorrupt: doc => doc.decoded !== true,
  }
  const codec = withSettingsDocPassthrough(appCodec, 'acct')
  const settingsId = settingsDocId('acct')

  it('bypasses the app codec for the settings document', () => {
    const decoded = codec.decode(settingsId, { prayerGoal: 3 })
    expect(decoded).toEqual({ id: settingsId, prayerGoal: 3 })
    expect(codec.isCorrupt(decoded)).toBe(false)
  })

  it('uses the app codec for every other document', () => {
    const decoded = codec.decode('item-1' as ItemId, { name: 'Alice' })
    expect(decoded).toEqual({ id: 'item-1', name: 'Alice', decoded: true })
    expect(codec.isCorrupt({ id: 'item-2' as ItemId })).toBe(true)
  })

  it('wraps the passthrough codec without changing it', () => {
    const wrapped = withSettingsDocPassthrough(passthroughCodec, 'acct')
    expect(wrapped.decode('item-1' as ItemId, { id: 'item-1' })).toEqual({ id: 'item-1' })
    expect(toAutomergeUrlFromItemId(settingsId)).toMatch(/^automerge:/)
  })
})
