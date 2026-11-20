import { MAX_FETCH_RESPONSE_CHARS, MAX_ITEM_SIZE_BYTES, QUOTA_EXCEEDED_MESSAGE, type ItemId, type VaultSnapshotInput } from '@vault/shared'
import { classifySyncError } from '../../utils/errorClassifier'
import type { SyncApiClient } from '../SyncApiClient'
import { FakeVaultServer } from './FakeVaultServer'
import { createSyncApiClient, RealVaultServer } from './vaultServers'

/**
 * The contract that keeps `FakeVaultServer` honest: each case makes the same calls through the
 * sync worker's API client to the fake and to the real server (its tRPC procedures on the test
 * DynamoDB Local), and expects the same answers. A case that fails only for the fake means the
 * fake has drifted, and the sync integration tests run against it no longer show what the server does.
 */


interface Backend {
  account: string
  api: SyncApiClient
  /** Makes every request fail as an unreachable server does, or stop failing */
  setDown(isDown: boolean): void
  /** Ends the session, or starts it again */
  setSessionEnded(isEnded: boolean): Promise<void>
  setOverQuota(quota: 'log' | 'storage', isOver: boolean): void
  stop(): Promise<void>
}

async function fakeBackend(): Promise<Backend> {
  const server = new FakeVaultServer()
  return {
    account: 'contract-account',
    api: createSyncApiClient(server),
    setDown: isDown => { server.isDown = isDown },
    setSessionEnded: async isEnded => { server.rejectsSessions = isEnded },
    setOverQuota: (quota, isOver) => {
      if (quota === 'log') server.isOverLogQuota = isOver
      else server.isOverStorageQuota = isOver
    },
    stop: async () => {},
  }
}

async function realBackend(): Promise<Backend> {
  const server = await new RealVaultServer().start()
  return {
    account: server.account,
    api: createSyncApiClient(server),
    setDown: isDown => { server.isDown = isDown },
    setSessionEnded: isEnded => (isEnded ? server.endSession() : server.startSession()),
    setOverQuota: (quota, isOver) => {
      if (quota === 'log') server.isOverLogQuota = isOver
      else server.isOverStorageQuota = isOver
    },
    stop: () => server.stop(),
  }
}

let nextId = 0
function newItemId(): ItemId {
  nextId += 1
  return `contract-item-${nextId}` as ItemId
}

function base64(text: string): string {
  return btoa(text)
}

function snapshot(itemId: ItemId, content: string, overrides: Partial<VaultSnapshotInput> = {}): VaultSnapshotInput {
  return {
    itemId,
    snapshot: { iv: 'snapshot-iv', cipher: base64(content), kver: '2', format: 2 },
    heads: { iv: 'heads-iv', cipher: base64(`heads of ${content.slice(0, 20)}`), kver: '2', format: 2 },
    ...overrides,
  }
}

function tombstone(itemId: ItemId): VaultSnapshotInput {
  return { itemId, deleted: true }
}

function message(itemId: ItemId, content: string) {
  return { itemId, encryptedMessage: { iv: 'row-iv', cipher: base64(content), kver: '2', format: 2 as const } }
}

/** What a rejected call tells the sync engine */
async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).not.toBeNull()
  const { isAuth, isNetwork, isServerError, status } = classifySyncError(error)
  return { isAuth, isNetwork, isServerError, status }
}

describe.each([
  ['the fake', fakeBackend],
  ['the real server', realBackend],
])('vault server contract: %s', (_name, createBackend) => {
  let backend: Backend
  let api: SyncApiClient
  let account: string

  beforeEach(async () => {
    backend = await createBackend()
    ;({ api, account } = backend)
  })

  afterEach(async () => {
    await backend.stop()
  })

  async function put(...snapshots: VaultSnapshotInput[]) {
    return api.putSnapshots({ account, snapshots })
  }

  async function manifestEntry(itemId: ItemId) {
    const { manifest } = await api.fetchManifest({ account })
    return manifest.find(entry => entry.itemId === itemId)
  }

  async function fetchOne(itemId: ItemId) {
    const { items, deferred } = await api.fetchSnapshotsByIds({ account, itemIds: [itemId] })
    expect(deferred).toEqual([])
    return items
  }

  describe('the log', () => {
    it('numbers pushed rows from 1 in order, and a poll reads its own rows', async () => {
      const [a, b] = [newItemId(), newItemId()]
      const before = Date.now()

      const result = await api.pollLog({ account, push: [message(a, 'one'), message(b, 'two')], after: 0 })

      expect(result.pushResults).toEqual([{ itemId: a, seq: 1 }, { itemId: b, seq: 2 }])
      expect(result.entries).toEqual([
        { seq: 1, ...message(a, 'one'), createdAt: expect.any(Number) },
        { seq: 2, ...message(b, 'two'), createdAt: expect.any(Number) },
      ])
      expect(result.entries[0].createdAt).toBeGreaterThanOrEqual(before)
      expect(result.hasMore).toBe(false)
      expect(result.serverNow).toBeGreaterThanOrEqual(result.entries[1].createdAt)
    })

    it('reads strictly after the position it is given', async () => {
      const itemId = newItemId()
      await api.pollLog({ account, push: [message(itemId, 'one'), message(itemId, 'two')], after: 0 })

      const result = await api.pollLog({ account, push: [message(itemId, 'three')], after: 2 })

      expect(result.pushResults).toEqual([{ itemId, seq: 3 }])
      expect(result.entries.map(entry => entry.seq)).toEqual([3])
      expect((await api.pollLog({ account, after: 3 })).entries).toEqual([])
    })

    it('pages the log 200 rows at a time', async () => {
      const itemId = newItemId()
      for (let pushed = 0; pushed < 201; pushed += 100) {
        const count = Math.min(100, 201 - pushed)
        await api.pollLog({ account, push: Array.from({ length: count }, (_, index) => message(itemId, `row ${pushed + index}`)), after: 201 })
      }

      const first = await api.pollLog({ account, after: 0 })
      const rest = await api.pollLog({ account, after: 200 })

      expect(first.entries).toHaveLength(200)
      expect(first.hasMore).toBe(true)
      expect(rest.entries.map(entry => entry.seq)).toEqual([201])
      expect(rest.hasMore).toBe(false)
    })

    it('refuses more than 100 rows in one push', async () => {
      const itemId = newItemId()
      const push = Array.from({ length: 101 }, (_, index) => message(itemId, `row ${index}`))

      expect(await rejection(api.pollLog({ account, push, after: 0 })))
        .toEqual({ isAuth: false, isNetwork: false, isServerError: false, status: 400 })
      expect((await api.pollLog({ account, after: 0 })).entries).toEqual([])
    })
  })

  describe('snapshots', () => {
    it('versions each write from 1, and reports the log head', async () => {
      const itemId = newItemId()
      await api.pollLog({ account, push: [message(itemId, 'row')], after: 0 })

      const first = await put(snapshot(itemId, 'one'))
      const second = await put(snapshot(itemId, 'two'))

      expect(first).toEqual({ success: true, persisted: 1, total: 1, results: [{ itemId, version: 1 }] })
      expect(second.results).toEqual([{ itemId, version: 2 }])
      expect(await fetchOne(itemId)).toEqual([{
        item: itemId,
        version: 2,
        metadata: { iv: '' },
        snapshot: snapshot(itemId, 'two').snapshot,
      }])
    })

    it('records its own clock as modifiedAt', async () => {
      const itemId = newItemId()
      const before = Date.now()

      await put(snapshot(itemId, 'one'))

      const entry = await manifestEntry(itemId)
      expect(entry?.modifiedAt).toBeGreaterThanOrEqual(before)
      expect(entry?.modifiedAt).toBeLessThanOrEqual(Date.now())
    })

    it('lists heads with the snapshot they came with, and drops them with a write that has none', async () => {
      const itemId = newItemId()
      await put(snapshot(itemId, 'one'))
      expect(await manifestEntry(itemId)).toEqual({
        itemId,
        version: 1,
        modifiedAt: expect.any(Number),
        heads: snapshot(itemId, 'one').heads,
      })

      await put(snapshot(itemId, 'two', { heads: undefined }))

      expect(await manifestEntry(itemId)).toEqual({ itemId, version: 2, modifiedAt: expect.any(Number) })
    })

    it('refuses an item over the size limit, persisting the rest of the batch', async () => {
      const [small, large] = [newItemId(), newItemId()]

      const result = await put(snapshot(small, 'one'), snapshot(large, 'x'.repeat(MAX_ITEM_SIZE_BYTES + 1024)))

      expect(result).toEqual({ success: false, persisted: 1, total: 2, results: [{ itemId: small, version: 1 }] })
      expect(await manifestEntry(large)).toBeUndefined()
    })

    it('leaves out an ID it has never seen', async () => {
      const known = newItemId()
      await put(snapshot(known, 'one'))

      const { items, deferred } = await api.fetchSnapshotsByIds({ account, itemIds: [newItemId(), known] })

      expect(items.map(item => item.item)).toEqual([known])
      expect(deferred).toEqual([])
    })

    it('defers the items past the response limit', async () => {
      // Items as large as the server stores, a few more of them than fit in one response
      const contentLength = 240 * 1024
      const fitting = Math.floor(MAX_FETCH_RESPONSE_CHARS / (Math.ceil(contentLength / 3) * 4))
      const itemIds = Array.from({ length: fitting + 2 }, () => newItemId())
      for (const itemId of itemIds) {
        await put(snapshot(itemId, itemId.padEnd(contentLength, 'x')))
      }

      const { items, deferred } = await api.fetchSnapshotsByIds({ account, itemIds })

      expect(items).toHaveLength(fitting)
      expect(deferred).toHaveLength(2)
      expect([...items.map(item => item.item), ...deferred].sort()).toEqual([...itemIds].sort())
    })
  })

  describe('deletion', () => {
    it('drops the snapshot and heads of an item deleted with a payload', async () => {
      const itemId = newItemId()
      await put(snapshot(itemId, 'one'))

      const result = await put(snapshot(itemId, 'last', { deleted: true }))

      expect(result.results).toEqual([{ itemId, version: 2 }])
      expect(await manifestEntry(itemId)).toEqual({ itemId, version: 2, modifiedAt: expect.any(Number), isDeleted: true })
      expect(await fetchOne(itemId)).toEqual([{ item: itemId, version: 2, metadata: { iv: '', deleted: true } }])
    })

    it('drops the stored snapshot for a payload-less tombstone', async () => {
      const itemId = newItemId()
      await put(snapshot(itemId, 'one'))

      expect((await put(tombstone(itemId))).results).toEqual([{ itemId, version: 2 }])

      expect(await manifestEntry(itemId)).toEqual({ itemId, version: 2, modifiedAt: expect.any(Number), isDeleted: true })
      expect(await fetchOne(itemId)).toEqual([{ item: itemId, version: 2, metadata: { iv: '', deleted: true } }])
    })

    it('answers version 0 for a payload-less tombstone of an ID it has never seen, and stores nothing', async () => {
      const itemId = newItemId()

      const result = await put(tombstone(itemId))

      expect(result).toMatchObject({ success: true, results: [{ itemId, version: 0 }] })
      expect(await manifestEntry(itemId)).toBeUndefined()
      expect(await fetchOne(itemId)).toEqual([])
    })

    it('keeps an item deleted, and its content dropped, when a snapshot arrives after the delete', async () => {
      const itemId = newItemId()
      await put(snapshot(itemId, 'one'))
      await put(tombstone(itemId))

      const result = await put(snapshot(itemId, 'from a device that missed the delete'))

      expect(result.results).toEqual([{ itemId, version: 3 }])
      expect(await manifestEntry(itemId)).toEqual({ itemId, version: 3, modifiedAt: expect.any(Number), isDeleted: true })
      expect(await fetchOne(itemId)).toEqual([{ item: itemId, version: 3, metadata: { iv: '', deleted: true } }])
    })
  })

  describe('failures', () => {
    it('reports an ended session as an auth failure, on every call', async () => {
      const itemId = newItemId()
      await backend.setSessionEnded(true)

      const authFailure = { isAuth: true, isNetwork: false, isServerError: false, status: 401 }
      expect(await rejection(api.pollLog({ account, push: [message(itemId, 'row')], after: 0 }))).toEqual(authFailure)
      expect(await rejection(put(snapshot(itemId, 'one')))).toEqual(authFailure)
      expect(await rejection(api.fetchManifest({ account }))).toEqual(authFailure)
      expect(await rejection(api.fetchSnapshotsByIds({ account, itemIds: [itemId] }))).toEqual(authFailure)

      await backend.setSessionEnded(false)
      expect((await api.pollLog({ account, after: 0 })).entries).toEqual([])
    })

    const quotaFailure = { isAuth: false, isNetwork: true, isServerError: false, status: 429 }

    it('turns away a push over the log quota with a 429, storing nothing, but still reads', async () => {
      const itemId = newItemId()
      backend.setOverQuota('log', true)

      const pushRejected = api.pollLog({ account, push: [message(itemId, 'row')], after: 0 })
      await expect(pushRejected).rejects.toThrow(QUOTA_EXCEEDED_MESSAGE)
      expect(await rejection(pushRejected)).toEqual(quotaFailure)
      expect((await api.pollLog({ account, after: 0 })).entries).toEqual([])
      expect((await put(snapshot(itemId, 'one'))).results).toEqual([{ itemId, version: 1 }])

      backend.setOverQuota('log', false)
      expect((await api.pollLog({ account, push: [message(itemId, 'row')], after: 0 })).pushResults)
        .toEqual([{ itemId, seq: 1 }])
    })

    it('turns away a batch with any snapshot over the storage quota with a 429, but still takes deletions', async () => {
      const [kept, deleted, itemId] = [newItemId(), newItemId(), newItemId()]
      await put(snapshot(kept, 'one'), snapshot(deleted, 'one'))
      backend.setOverQuota('storage', true)

      const putRejected = put(snapshot(itemId, 'one'), tombstone(kept))
      await expect(putRejected).rejects.toThrow(QUOTA_EXCEEDED_MESSAGE)
      expect(await rejection(putRejected)).toEqual(quotaFailure)
      expect(await manifestEntry(kept)).toMatchObject({ version: 1 })
      expect((await put(tombstone(deleted))).results).toEqual([{ itemId: deleted, version: 2 }])
      expect((await api.pollLog({ account, push: [message(itemId, 'row')], after: 0 })).pushResults)
        .toEqual([{ itemId, seq: 1 }])

      backend.setOverQuota('storage', false)
      expect((await put(snapshot(itemId, 'one'))).results).toEqual([{ itemId, version: 1 }])
    })

    it('reports an unreachable server as a network failure', async () => {
      backend.setDown(true)

      expect(await rejection(api.pollLog({ account, after: 0 })))
        .toEqual({ isAuth: false, isNetwork: true, isServerError: false, status: undefined })

      backend.setDown(false)
      expect((await api.pollLog({ account, after: 0 })).entries).toEqual([])
    })
  })
})
