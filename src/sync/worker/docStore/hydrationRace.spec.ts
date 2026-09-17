import { Repo, interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { AutomergeDocStore } from './AutomergeDocStore'
import { SyncPullQueueManager } from '../SyncPullQueueManager'
import { CursorStore } from '../stores/CursorStore'
import { toAutomergeUrlFromItemId } from '../utils/automerge'
import { ItemId } from 'src/shared/schemas/items'
import type { Item } from 'src/state/items'

// Mock localforage for CursorStore
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation(() => {
      const store = new Map<string, any>()
      return {
        getItem: vi.fn().mockImplementation(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn().mockImplementation(async (k: string, v: any) => {
          store.set(k, v)
          return v
        }),
        removeItem: vi.fn().mockImplementation(async (k: string) => store.delete(k)),
        clear: vi.fn().mockImplementation(async () => store.clear()),
        keys: vi.fn().mockImplementation(async () => Array.from(store.keys())),
        length: vi.fn().mockImplementation(async () => store.size),
        iterate: vi.fn(),
      }
    }),
  },
}))

const mockDecryptBytes = vi.fn()
vi.mock('src/api/vault', () => ({
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
  hasVaultKey: vi.fn().mockReturnValue(true),
  waitForKeyVersion: vi.fn().mockResolvedValue(true),
}))

function createBaseDocBinary(id: ItemId, name = 'Base Name', description = 'Base Desc'): Uint8Array {
  const doc = Automerge.change(Automerge.init<Item>(), d => {
    d.id = id
    d.type = 'person'
    d.name = name
    d.description = description
    d.created = 1000
    d.archived = false
    d.prayerFrequency = 'none'
    d.notes = [{ id: 'note-base', text: 'Base Note', archived: false, time: 1000 }]
    d.prayedFor = []
  })
  return Automerge.save(doc)
}

function forkDocBinary(baseBinary: Uint8Array, changeFn: (d: Item) => void): Uint8Array {
  const doc = Automerge.load<Item>(baseBinary)
  const updated = Automerge.change(doc, changeFn)
  return Automerge.save(updated)
}

describe('Document Hydration Race Condition (C4)', () => {
  let repo: Repo
  let docStore: AutomergeDocStore
  let cursorStore: CursorStore
  let pullQueueManager: SyncPullQueueManager

  beforeEach(async () => {
    repo = new Repo()
    docStore = new AutomergeDocStore(repo)
    cursorStore = new CursorStore('test-account')
    pullQueueManager = new SyncPullQueueManager(cursorStore, docStore)
    await pullQueueManager.setAccount('test-account')
    mockDecryptBytes.mockReset()
    mockDecryptBytes.mockImplementation(async (entry: any) => entry._rawBytes ?? new Uint8Array())
  })

  it('serializes concurrent hydrateAutomergeDocumentBinary calls on the same item without clobbering', async () => {
    const itemId = 'concurrent-item-1' as ItemId
    const baseBinary = createBaseDocBinary(itemId)

    const binary1 = forkDocBinary(baseBinary, d => {
      d.name = 'First Hydration Name'
      d.notes.push({ id: 'note-1', text: 'Note 1', archived: false, time: 2000 })
    })
    const binary2 = forkDocBinary(baseBinary, d => {
      d.description = 'Second Hydration Desc'
      d.notes.push({ id: 'note-2', text: 'Note 2', archived: false, time: 3000 })
    })

    // Run both hydrations concurrently
    const [res1, res2] = await Promise.all([
      docStore.hydrateAutomergeDocumentBinary(itemId, binary1),
      docStore.hydrateAutomergeDocumentBinary(itemId, binary2),
    ])

    expect(res1).toBeDefined()
    expect(res2).toBeDefined()

    const item = await docStore.getAutomergeItem(itemId)
    expect(item).not.toBeNull()
    // The second hydration should have merged into the first cleanly
    expect(item?.name).toBe('First Hydration Name')
    expect(item?.description).toBe('Second Hydration Desc')
    const noteTexts = item?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Note 1')
    expect(noteTexts).toContain('Note 2')
  })

  it('prevents pull queue message application from interleaving during async storage I/O in hydration', async () => {
    const itemId = 'race-item-1' as ItemId
    const baseBinary = createBaseDocBinary(itemId)

    // Prepare an incremental edit message from Device A
    const baseDoc = Automerge.load<Item>(baseBinary)
    const updatedDoc = Automerge.change(baseDoc, d => {
      d.description = 'Incremental Edit from Device A'
      d.notes.push({ id: 'note-inc', text: 'Incremental Note', archived: false, time: 2000 })
    })
    // Generate Automerge sync message containing the incremental change
    const syncStateA = Automerge.initSyncState()
    const [, syncMsg] = Automerge.generateSyncMessage(updatedDoc, syncStateA)
    expect(syncMsg).toBeDefined()

    // Hook loadDocDataFromStorage on docStore to simulate async disk I/O delay
    let resolveStorageDelay: () => void
    const storageDelayPromise = new Promise<void>(resolve => {
      resolveStorageDelay = resolve
    })

    const originalLoadDocData = docStore.loadDocDataFromStorage.bind(docStore)
    vi.spyOn(docStore, 'loadDocDataFromStorage').mockImplementation(async (id: ItemId) => {
      if (id === itemId) {
        // Wait until we explicitly trigger pull processing while storage is reading
        await storageDelayPromise
      }
      return originalLoadDocData(id)
    })

    let pullProcessed = false
    pullQueueManager.eventHub.subscribe(e => {
      if (e.type === 'messageParsed') {
        const handle = repo.handles[e.documentId]
        if (handle) {
          const tempHandle = repo.import(Automerge.save(updatedDoc))
          try {
            handle.merge(tempHandle)
          } finally {
            try {
              repo.delete(tempHandle.documentId)
            } catch {
              // ignore cleanup error
            }
          }
        }
        pullProcessed = true
      }
    })

    mockDecryptBytes.mockResolvedValueOnce(syncMsg)

    // 1. Start hydration (which enters withItemLock and waits on storageDelayPromise)
    const hydrationPromise = docStore.hydrateAutomergeDocumentBinary(itemId, baseBinary)

    // 2. Concurrently, pull queue receives incremental sync message for itemId
    const pullPromise = pullQueueManager.processPullResults([
      {
        itemId,
        cursor: 100,
        hasMore: false,
        messages: [
          {
            cursor: 100,
            encryptedMessage: {
              iv: 'iv-100',
              cipher: 'cipher-100',
              version: '0',
            } as any,
          },
        ],
      },
    ])

    // Verify pull queue has NOT processed the message yet because hydration holds the item lock!
    await new Promise(r => setTimeout(r, 20))
    expect(pullProcessed).toBe(false)

    // 3. Now let storage I/O resolve, allowing hydration to finish and seed/merge
    resolveStorageDelay!()
    await hydrationPromise

    // 4. Pull queue can now acquire the lock and apply the incremental sync message
    await pullPromise
    expect(pullProcessed).toBe(true)

    // 5. Verify that the document has BOTH baseline and incremental changes!
    const item = await docStore.getAutomergeItem(itemId)
    expect(item).not.toBeNull()
    expect(item?.name).toBe('Base Name')
    expect(item?.description).toBe('Incremental Edit from Device A')
    const noteTexts = item?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Incremental Note')
  })

  it('coordinates when pull queue processing runs before hydration', async () => {
    const itemId = 'race-item-2' as ItemId
    const baseBinary = createBaseDocBinary(itemId)

    // 1. Device A makes an incremental edit
    const baseDoc = Automerge.load<Item>(baseBinary)
    const docA = Automerge.change(baseDoc, d => {
      d.name = 'Device A Name'
      d.notes.push({ id: 'note-a', text: 'Device A Note', archived: false, time: 2000 })
    })
    const [, syncMsgA] = Automerge.generateSyncMessage(docA, Automerge.initSyncState())

    // 2. Device B (remote) makes a different edit and creates a snapshot
    const docB = Automerge.change(Automerge.load<Item>(baseBinary), d => {
      d.description = 'Device B Desc'
      d.notes.push({ id: 'note-b', text: 'Device B Note', archived: false, time: 3000 })
    })
    const snapshotB = Automerge.save(docB)

    // First, seed initial handle from baseBinary so pull queue can apply changes
    repo.import<any>(baseBinary, {
      docId: interpretAsDocumentId(toAutomergeUrlFromItemId(itemId)),
    })

    pullQueueManager.eventHub.subscribe(e => {
      if (e.type === 'messageParsed') {
        const handle = repo.handles[e.documentId]
        if (handle) {
          const tempHandle = repo.import(Automerge.save(docA))
          try {
            handle.merge(tempHandle)
          } finally {
            try {
              repo.delete(tempHandle.documentId)
            } catch {
              // ignore cleanup error
            }
          }
        }
      }
    })

    mockDecryptBytes.mockResolvedValueOnce(syncMsgA)

    // Pull queue applies message from Device A
    await pullQueueManager.processPullResults([
      {
        itemId,
        cursor: 200,
        hasMore: false,
        messages: [
          {
            cursor: 200,
            encryptedMessage: {
              iv: 'iv-200',
              cipher: 'cipher-200',
              version: '0',
            } as any,
          },
        ],
      },
    ])

    // Now hydrate snapshot from Device B
    const hydrationResult = await docStore.hydrateAutomergeDocumentBinary(itemId, snapshotB)
    expect(hydrationResult).toBeDefined()

    // Verify non-destructive CRDT merge of Device A and Device B
    const finalItem = await docStore.getAutomergeItem(itemId)
    expect(finalItem?.name).toBe('Device A Name')
    expect(finalItem?.description).toBe('Device B Desc')
    const noteTexts = finalItem?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Device A Note')
    expect(noteTexts).toContain('Device B Note')
  })

  it('defense-in-depth: merges into inMemoryHandle if handle became ready during storage check', async () => {
    const itemId = 'defense-item-1' as ItemId
    const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))
    const baseBinary = createBaseDocBinary(itemId)

    const snapshotBinary = forkDocBinary(baseBinary, d => {
      d.description = 'Snapshot Desc'
      d.notes.push({ id: 'note-snap', text: 'Snapshot Note', archived: false, time: 2500 })
    })

    // Hook storage to simulate creating a handle in repo while storage is reading
    vi.spyOn(docStore, 'loadDocDataFromStorage').mockImplementation(async () => {
      // Simulate an external background process creating and making ready a handle
      const existingBinary = forkDocBinary(baseBinary, d => {
        d.name = 'Existing In-Memory Name'
        d.notes.push({ id: 'note-existing', text: 'Existing Note', archived: false, time: 2000 })
      })
      repo.import(existingBinary, { docId: documentId })
      return undefined // storage returned nothing
    })

    // Now run hydration
    await docStore.hydrateAutomergeDocumentBinary(itemId, snapshotBinary)

    // Verify it did NOT wipe out the in-memory handle, but merged with it!
    const item = await docStore.getAutomergeItem(itemId)
    expect(item).not.toBeNull()
    expect(item?.name).toBe('Existing In-Memory Name')
    expect(item?.description).toBe('Snapshot Desc')
    const noteTexts = item?.notes?.map(n => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Existing Note')
    expect(noteTexts).toContain('Snapshot Note')
  })

  it('defense-in-depth: seedImportedDocument does not evict an existing ready handle', async () => {
    const itemId = 'seed-defense-1' as ItemId
    const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))
    const baseBinary = createBaseDocBinary(itemId)

    // Pre-seed an existing ready handle
    const existingBinary = forkDocBinary(baseBinary, d => {
      d.name = 'Pre-Existing Handle'
      d.notes.push({ id: 'pre-1', text: 'Pre Note', archived: false, time: 2000 })
    })
    const existingHandle = repo.import(existingBinary, { docId: documentId })

    const removeFromCacheSpy = vi.spyOn(repo, 'removeFromCache')

    // Call seedImportedDocument with incoming binary
    const incomingBinary = forkDocBinary(baseBinary, d => {
      d.description = 'New Snapshot Desc'
      d.notes.push({ id: 'new-1', text: 'New Note', archived: false, time: 3000 })
    })
    const resultHandle = await docStore.seedImportedDocument(itemId, incomingBinary)

    // Assert: did NOT call removeFromCache
    expect(removeFromCacheSpy).not.toHaveBeenCalled()
    expect(resultHandle).toBe(existingHandle)

    // Assert: merged into existing handle
    const doc = existingHandle.doc() as any
    expect(doc?.name).toBe('Pre-Existing Handle')
    expect(doc?.description).toBe('New Snapshot Desc')
    const noteTexts = doc?.notes?.map((n: any) => n.text)
    expect(noteTexts).toContain('Base Note')
    expect(noteTexts).toContain('Pre Note')
    expect(noteTexts).toContain('New Note')
  })

  it('findOrCreateHandle called during hydration waits and returns the hydrated handle', async () => {
    const itemId = 'find-create-race-1' as ItemId
    const snapshotBinary = createBaseDocBinary(itemId, 'Hydrated Name', 'Hydrated Desc')

    let resolveStorage: () => void
    const storageWait = new Promise<void>(r => {
      resolveStorage = r
    })

    vi.spyOn(docStore, 'loadDocDataFromStorage').mockImplementation(async () => {
      await storageWait
      return undefined
    })

    // Start hydration
    const hydratePromise = docStore.hydrateAutomergeDocumentBinary(itemId, snapshotBinary)

    // Call findOrCreateHandle concurrently
    const findOrCreatePromise = docStore.findOrCreateHandle(itemId)

    // Let hydration finish storage I/O
    resolveStorage!()

    const [hydrateResult, handle] = await Promise.all([hydratePromise, findOrCreatePromise])
    expect(hydrateResult).toBeDefined()
    expect(handle).toBeDefined()

    // Handle should have the hydrated content, not blank document
    const doc = handle?.doc() as any
    expect(doc?.name).toBe('Hydrated Name')
  })
})
