import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId } from '@vault/shared'
import type { Keyring } from '../keys/Keyring'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createAccountKeys, Device, FakeVaultServer, installLocalStorage } from './__test__/syncLogHarness'

const DAY = 24 * 60 * 60 * 1000

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)))
  }
  return bytes
}

describe('sync log', () => {
  let server: FakeVaultServer
  let keys: Keyring
  const devices: Device[] = []

  async function startDevice(name: string, options?: ConstructorParameters<typeof Device>[3]): Promise<Device> {
    const device = new Device(name, server, keys, options)
    devices.push(device)
    return device.start()
  }

  beforeEach(async () => {
    installLocalStorage()
    server = new FakeVaultServer()
    keys = await createAccountKeys()
  })

  afterEach(async () => {
    await Promise.all(devices.splice(0).map(device => device.context.session.isShutdown ? null : device.stop()))
  })

  it('delivers an edit from one device to another through the log', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await a.poll()
    await b.poll()

    const itemId = await a.create('item-1', { title: 'first' })
    await a.poll()
    await b.poll()

    expect((await b.read(itemId))?.title).toBe('first')

    await b.edit(itemId, { title: 'second' })
    await b.poll()
    await a.poll()

    expect((await a.read(itemId))?.title).toBe('second')
    expect(server.head).toBe(2)
    expect(await a.pending()).toEqual([])
    expect(await b.pending()).toEqual([])
  })

  it('keeps pulled changes from being marked pending or pushed back', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await a.poll()
    await b.poll()

    const itemId = await a.create('item-1', { title: 'first' })
    await a.poll()
    await b.poll()
    await b.poll()

    expect(await b.pending()).toEqual([])
    expect(server.rows.map(row => row.itemId)).toEqual([itemId])
  })

  it('resends pulled changes at most once from a device that was also editing', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await a.poll()
    await b.poll()
    const itemId = await a.create('item-1', { title: 'first' })
    await a.sync()
    await b.sync()

    await a.edit(itemId, { title: 'from a' })
    await b.edit(itemId, { body: 'from b' })
    await a.poll()
    await b.poll()
    await a.poll()
    const rows = server.head
    await a.poll()
    await b.poll()

    expect(server.head).toBe(rows)
    expect(await a.read(itemId)).toMatchObject({ title: 'from a', body: 'from b' })
    expect(await b.read(itemId)).toMatchObject({ title: 'from a', body: 'from b' })
  })

  it('stops at a row that is not visible yet, then applies both in order', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await a.poll()
    await b.poll()

    const first = await a.create('item-1', { title: 'one' })
    await a.poll()
    const second = await a.create('item-2', { title: 'two' })
    await a.poll()

    server.hiddenSeqs.add(1)
    await b.poll()

    expect(b.services.puller.cursor).toBe(0)
    expect(b.services.puller.gapRepollDelay).toBe(SYNC_TIMEOUTS.gapRepollBase)
    expect(b.services.puller.hasImmediatePendingPulls()).toBe(false)
    expect(await b.read(second)).toBeNull()

    server.hiddenSeqs.clear()
    await b.poll()

    expect(b.services.puller.cursor).toBe(2)
    expect(b.services.puller.gapRepollDelay).toBeUndefined()
    expect((await b.read(first))?.title).toBe('one')
    expect((await b.read(second))?.title).toBe('two')
  })

  it('moves past a lost row, and heals the item from its snapshot in the same poll', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    const itemId = await a.create('item-1', { title: 'one' })
    await a.sync()
    await b.sync()

    await a.edit(itemId, { title: 'two' })
    await a.sync()
    await a.edit(itemId, { title: 'three' })
    await a.poll()
    const lost = server.head - 1
    server.loseRow(lost)
    // The row after the gap is old enough that the missing one can't still be in flight
    const later = server.clock() + SYNC_TIMEOUTS.gapWait
    server.clock = () => later

    await b.poll()

    expect(b.services.puller.cursor).toBe(server.head)
    expect((await b.read(itemId))?.title).toBe('three')
  })

  it('keeps a parked row across a reload and applies it once the snapshot arrives', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    const itemId = await a.create('item-1', { title: 'one' })
    await a.poll()
    await a.edit(itemId, { title: 'two' })
    await a.poll()
    // A row B can't apply: its parent is in a row B never sees
    server.loseRow(1)
    server.items.clear()
    await b.poll()
    expect(await b.read(itemId)).toBeNull()

    await b.restart()
    await a.edit(itemId, { title: 'three' })
    await a.uploadSnapshots()
    await b.poll()

    expect((await b.read(itemId))?.title).toBe('three')
  })

  describe('snapshot coverage', () => {
    /** Two devices with one item, where A's new change is hidden from B while B uploads its own */
    async function raceSnapshots() {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'base' })
      await a.sync()
      await b.sync()

      await a.edit(itemId, { title: 'from a' })
      await b.edit(itemId, { body: 'from b' })
      await a.uploadSnapshots()
      server.hiddenSeqs.add(server.head)
      await b.uploadSnapshots()
      server.hiddenSeqs.clear()
      return { a, b, itemId }
    }

    it('catches up a snapshot that replaced another device\'s (S2)', async () => {
      const { b, itemId } = await raceSnapshots()
      const raced = server.items.get(itemId)!.version

      await b.poll()
      await b.uploadSnapshots()

      expect(server.items.get(itemId)!.version).toBeGreaterThan(raced)
      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      expect(await c.read(itemId)).toMatchObject({ title: 'from a', body: 'from b' })
    })

    it('heals the same race from the manifest check alone (S3)', async () => {
      const { a, b, itemId } = await raceSnapshots()
      vi.spyOn(b.services.snapshotCoverage, 'onSnapshotStored').mockResolvedValue(undefined)
      await a.poll()

      await a.manifestSync()
      await a.uploadSnapshots()

      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      expect(await c.read(itemId)).toMatchObject({ title: 'from a', body: 'from b' })
    })

    it('never builds a snapshot holding what the log lacks (S1)', async () => {
      const a = await startDevice('device-a')
      await a.poll()
      const itemId = await a.create('item-1', { title: 'base' })

      await a.uploadSnapshots()

      expect(server.rows.map(row => row.itemId)).toEqual([itemId])
      expect(server.items.get(itemId)?.version).toBe(1)
    })

    it('uploads for an author that never comes back, once it has had a day', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'base' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'author gone' })
      await a.poll()
      await a.stop()
      await b.poll()

      await b.manifestSync()
      await b.uploadSnapshots()
      expect(server.items.get(itemId)?.version).toBe(1)

      const later = Date.now() + SYNC_TIMEOUTS.pulledChangesGrace + 1000
      vi.spyOn(Date, 'now').mockReturnValue(later)
      await b.manifestSync()
      await b.uploadSnapshots()
      expect(server.items.get(itemId)?.version).toBe(2)

      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      expect((await c.read(itemId))?.title).toBe('author gone')

      // Confirmed now, so it's forgotten
      await b.manifestSync()
      expect((await b.services.snapshotCoverage.listUnconfirmedPulls()).size).toBe(0)
    })
  })

  it('pushes a follower\'s edit from its persisted mark after the leader goes', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await b.poll()
    await a.poll()
    const itemId = await a.create('item-1', { title: 'first' })
    await a.poll()
    a.context.session.setLeader(false)

    await a.edit(itemId, { title: 'from a follower' })
    await a.settle()
    expect(await a.pending()).toEqual([itemId])

    a.context.session.setLeader(true)
    await a.poll()
    await b.poll()

    expect((await b.read(itemId))?.title).toBe('from a follower')
    expect(await a.pending()).toEqual([])
  })

  it('splits a change set over the row limit, and another device applies the rows in order', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await a.poll()
    await b.poll()
    const itemId = await a.create('item-1', { title: 'first' })
    await a.poll()

    const blocks = Array.from({ length: 3 }, () => randomBytes(150 * 1024))
    for (const [index, block] of blocks.entries()) {
      await a.services.docStore.changeDocument(itemId, draft => {
        draft[`block${index}`] = block
      })
    }
    await a.services.changeOutbox.mark(itemId)
    await a.poll()
    await b.poll()

    expect(server.rows.length).toBeGreaterThan(2)
    expect((await b.read(itemId))?.block2).toEqual(blocks[2])
    expect(await b.services.docStore.getMissingDeps(itemId)).toEqual([])
    expect(await a.pending()).toEqual([])
  })

  it('delivers a change too large for a row with a snapshot, writing no row', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    const itemId = await a.create('item-1', { title: 'first' })
    await a.sync()
    await b.sync()
    const rows = server.rows.length

    await a.services.docStore.changeDocument(itemId, draft => {
      draft.blob = randomBytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1024)
    })
    await a.services.changeOutbox.mark(itemId)
    a.services.snapshotManager.tracker.markItemDirty(itemId)
    await a.poll()
    await a.uploadSnapshots()

    expect(server.rows).toHaveLength(rows)
    await a.poll()
    expect(await a.pending()).toEqual([])

    await b.manifestSync()
    expect((await b.read(itemId))?.blob).toBeInstanceOf(Uint8Array)
  })

  describe('catching up', () => {
    it('runs a manifest sync before reading for a device that was away past the TTL', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'while b was away' })
      await a.sync()

      const start = Date.now()
      server.clock = () => start + 28 * DAY
      await a.edit(itemId, { title: 'after the TTL' })
      await a.sync()
      server.expireLog(server.head - 1)
      server.clock = () => start + 28 * DAY + SYNC_TIMEOUTS.gapWait
      const syncNow = vi.spyOn(b.services.manifestSyncManager, 'syncNow')

      expect(await b.poll()).toBe('success')

      expect(syncNow).toHaveBeenCalledTimes(1)
      expect((await b.read(itemId))?.title).toBe('after the TTL')
      expect(b.services.puller.cursor).toBe(server.head)
    })

    it('moves a new device past rows the TTL removed, with no second manifest sync', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.edit(itemId, { title: 'second' })
      await a.sync()
      const start = Date.now()
      server.expireLog(1)
      server.clock = () => start + SYNC_TIMEOUTS.gapWait

      const b = await startDevice('device-b')
      const syncNow = vi.spyOn(b.services.manifestSyncManager, 'syncNow')
      expect(await b.poll()).toBe('success')

      expect(syncNow).toHaveBeenCalledTimes(1)
      expect(b.services.puller.cursor).toBe(server.head)
      expect(b.services.puller.takeManifestSyncRequest()).toBe(false)
    })

    it('still waits on a fresh gap while catching up', async () => {
      const a = await startDevice('device-a')
      await a.create('item-1', { title: 'first' })
      await a.poll()
      await a.create('item-2', { title: 'second' })
      await a.poll()
      server.hiddenSeqs.add(1)

      const b = await startDevice('device-b')
      await b.poll()

      expect(b.services.puller.cursor).toBe(0)
      expect(b.services.puller.gapRepollDelay).toBeDefined()
    })
  })

  describe('first start', () => {
    /** Restarts a device as the first start of the new build, against a log that starts empty */
    async function crossTheCut(device: Device, oldHeads?: [ItemId, string[]][]): Promise<void> {
      await device.rewindToOldBuild(oldHeads)
      await device.start()
    }

    function resetLog(): void {
      server.rows = []
      server.head = 0
    }

    it('pushes an unpushed edit, even one old server heads claim is synced', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.edit(itemId, { title: 'edited on the old build' })
      await a.settle()
      const heads = await a.services.docStore.readHeads(itemId)
      resetLog()

      await crossTheCut(a, [[itemId, heads!]])
      expect(await a.poll()).toBe('success')

      expect(server.rows.map(row => row.itemId)).toEqual([itemId])
      const b = await startDevice('device-b')
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('edited on the old build')
    })

    it('pushes nothing for an item matching its snapshot, and clears its mark', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      resetLog()

      await crossTheCut(a)
      expect(await a.pending()).toEqual([itemId])
      await a.poll()

      expect(server.rows).toEqual([])
      expect(await a.pending()).toEqual([])
      expect(a.services.firstStart.has(itemId)).toBe(false)
    })

    it('uploads a snapshot for an item the server has none of, and its confirmation sets server heads', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      resetLog()
      server.items.clear()

      await crossTheCut(a)
      await a.poll()
      expect(a.services.firstStart.stateOf(itemId)).toBe('awaitingSnapshot')
      expect(server.rows).toEqual([])

      await a.uploadSnapshots()
      await a.poll()

      expect(server.items.get(itemId)?.version).toBe(1)
      expect(a.services.firstStart.has(itemId)).toBe(false)
      expect(a.services.serverHeads.get(itemId)).toEqual(await a.services.docStore.readHeads(itemId))
      expect(server.rows).toEqual([])
    })

    it('does not upload over a snapshot without heads that the doc has not merged', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'only in the snapshot' })
      await a.sync()
      resetLog()
      delete server.items.get(itemId)!.heads
      const fetchSnapshots = vi.spyOn(server, 'fetchSnapshotsByIds').mockImplementationOnce(() => {
        throw new TypeError('Failed to fetch')
      })

      await crossTheCut(b)
      await b.poll()

      expect(fetchSnapshots).toHaveBeenCalled()
      expect(b.services.firstStart.stateOf(itemId)).toBe('awaitingHeads')
      const version = server.items.get(itemId)!.version
      await b.uploadSnapshots()
      expect(server.items.get(itemId)!.version).toBe(version)
    })

    it('needs no network for the local part, and runs the rest once online', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      resetLog()
      server.isDown = true

      await crossTheCut(a)
      await a.edit(itemId, { title: 'edited offline' })
      expect(await a.poll()).toBe('failure')
      expect(await a.pending()).toEqual([itemId])

      server.isDown = false
      expect(await a.poll()).toBe('success')
      expect(server.rows.map(row => row.itemId)).toEqual([itemId])
    })

    it('leaves a later start alone once the reset has run', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      const heads = a.services.serverHeads.get(itemId)
      await a.services.serverHeads.save()

      await a.restart()

      expect(a.services.serverHeads.get(itemId)).toEqual(heads)
      expect(a.services.firstStart.has(itemId)).toBe(false)
    })

    it('carries both sides across when two devices hold changes the other lacks, without snapshot heads', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'from a' })
      await b.edit(itemId, { body: 'from b' })
      await a.settle()
      await b.settle()
      resetLog()
      delete server.items.get(itemId)!.heads

      await crossTheCut(a)
      await crossTheCut(b)
      await a.sync()
      await b.sync()
      await a.sync()
      await a.manifestSync()
      await b.manifestSync()
      await a.sync()
      await b.sync()

      const c = await startDevice('device-c')
      await c.poll()
      for (const device of [a, b, c]) {
        expect(await device.read(itemId)).toMatchObject({ title: 'from a', body: 'from b' })
      }
    })

    it('carries both sides across when the snapshot has heads', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'from a' })
      await b.edit(itemId, { body: 'from b' })
      await a.settle()
      await b.settle()
      resetLog()

      await crossTheCut(a)
      await crossTheCut(b)
      await a.sync()
      await b.sync()
      await a.sync()

      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      for (const device of [a, b, c]) {
        expect(await device.read(itemId)).toMatchObject({ title: 'from a', body: 'from b' })
      }
    })
  })

  describe('rewrites', () => {
    it('pushes an unpushed change first, then rewrites, failing and quarantining nothing', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.edit(itemId, { title: 'unpushed' })
      await a.settle()
      const rows = server.rows.length

      const result = await a.services.itemReencryptor.run()

      expect(result).toEqual({ succeeded: [itemId], failed: [] })
      expect(server.rows.length).toBe(rows + 1)
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
    })

    it('waits for the network part of first start', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.rewindToOldBuild()
      await a.start()

      let finished = false
      const run = a.services.itemReencryptor.run().then(result => {
        finished = true
        return result
      })
      await a.settle()
      expect(finished).toBe(false)

      await a.poll()

      expect(await run).toEqual({ succeeded: [itemId], failed: [] })
    })

    it('reports an item still waiting for its heads as failed, without quarantining it', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.rewindToOldBuild()
      await a.start()
      const heads = server.items.get(itemId)!.heads!
      server.items.get(itemId)!.heads = { ...heads, kver: '9' }
      await a.poll()
      expect(a.services.firstStart.stateOf(itemId)).toBe('awaitingHeads')

      const result = await a.services.itemReencryptor.run()

      expect(result.failed.map(failure => failure.itemId)).toEqual([itemId])
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
    })

    it('rechecks a rewrite that jumped a version', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'from a' })
      await a.uploadSnapshots()
      server.hiddenSeqs.add(server.head)

      await b.services.itemReencryptor.run()
      server.hiddenSeqs.clear()
      await b.poll()
      await b.uploadSnapshots()

      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      expect((await c.read(itemId))?.title).toBe('from a')
    })
  })

  it('marks restored items pending and dirty, whatever an old backup says', async () => {
    const a = await startDevice('device-a')
    const itemId = await a.create('item-1', { title: 'first' })
    await a.sync()

    await a.context.markRestored([itemId])

    expect(await a.pending()).toEqual([itemId])
    expect(a.services.snapshotManager.tracker.isDirty(itemId)).toBe(true)
  })
})
