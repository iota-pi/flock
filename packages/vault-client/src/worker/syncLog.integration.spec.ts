import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId } from '@vault/shared'
import type { Keyring } from '../keys/Keyring'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { FakeVaultServer } from './__test__/FakeVaultServer'
import { createAccountKeys, Device, installLocalStorage } from './__test__/syncLogHarness'

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

    it('heals a snapshot that replaced another device\'s at the replaced author\'s manifest sync (S2)', async () => {
      const { a, itemId } = await raceSnapshots()
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

    it('forgets pulled changes to an item that was deleted before any snapshot confirmed them', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'base' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'unconfirmed' })
      await a.poll()
      await b.poll()
      expect((await b.services.snapshotCoverage.listUnconfirmedPulls()).has(itemId)).toBe(true)

      await a.edit(itemId, { deleted: true })
      await a.sync()
      await b.manifestSync()

      expect(server.items.get(itemId)?.deleted).toBe(true)
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

  describe('a leader and a follower on one device', () => {
    /** Two tabs of device A, sharing its storage and talking over the broadcast adapter, and device B */
    async function startTabs() {
      const leader = await startDevice('device-a')
      const follower = await startDevice('device-a', { isLeader: false })
      const b = await startDevice('device-b')
      const itemId = await leader.create('item-1', { title: 'first' })
      await leader.sync()
      await b.sync()
      await vi.waitFor(async () => expect((await follower.read(itemId))?.title).toBe('first'))
      return { leader, follower, b, itemId }
    }

    it('pushes a follower\'s edit from the leader, which learns of it over the broadcast adapter', async () => {
      const { leader, follower, b, itemId } = await startTabs()

      await follower.edit(itemId, { title: 'from the follower' })
      await follower.settle()
      await vi.waitFor(async () => expect((await leader.read(itemId))?.title).toBe('from the follower'))
      await vi.waitFor(() => expect(leader.services.snapshotManager.tracker.isDirty(itemId)).toBe(true))
      expect(await follower.poll()).toBe('no-poll')
      expect(server.rows).toHaveLength(1)

      await leader.sync()
      await b.poll()

      expect((await b.read(itemId))?.title).toBe('from the follower')
      expect(await leader.pending()).toEqual([])
      expect(server.items.get(itemId)?.version).toBe(2)
    })

    it('hands a change the leader pulls to the follower, which never polls', async () => {
      const { leader, follower, b, itemId } = await startTabs()

      await b.edit(itemId, { title: 'from device b' })
      await b.poll()
      await leader.poll()

      await vi.waitFor(async () => expect((await follower.read(itemId))?.title).toBe('from device b'))
      expect(await leader.pending()).toEqual([])
      expect(server.rows).toHaveLength(2)
    })

    it('converges while both tabs lead, as they may just after one steals the lock', async () => {
      const { leader, follower, b, itemId } = await startTabs()
      follower.context.session.setLeader(true)

      await leader.edit(itemId, { title: 'from the old leader' })
      await follower.edit(itemId, { notes: 'from the new leader' })
      await leader.settle()
      await vi.waitFor(async () => expect((await follower.read(itemId))?.title).toBe('from the old leader'))
      await vi.waitFor(async () => expect((await leader.read(itemId))?.notes).toBe('from the new leader'))
      // Both push what they have, and each pulls the other's rows
      await Promise.all([leader.sync(), follower.sync()])
      leader.context.session.setLeader(false)
      await follower.sync()
      await b.sync()

      for (const device of [leader, follower, b]) {
        expect(await device.read(itemId)).toMatchObject({ title: 'from the old leader', notes: 'from the new leader' })
      }
      expect(await follower.heads(itemId)).toEqual(await b.heads(itemId))
      expect(await leader.pending()).toEqual([])
      expect(await follower.quarantined()).toEqual([])
      expect(await b.quarantined()).toEqual([])
    })
  })

  describe('both outbound loops', () => {
    /** Device A with an edit that the log and a snapshot both still have to carry, and device B */
    async function editToSend() {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'second' })
      await a.settle()
      return { a, b, itemId, rows: server.rows.length, version: server.items.get(itemId)!.version }
    }

    async function expectHeld(a: Device, itemId: ItemId, rows: number, version: number) {
      expect(await a.pending()).toEqual([itemId])
      expect(a.services.snapshotManager.tracker.isDirty(itemId)).toBe(true)
      expect(server.rows).toHaveLength(rows)
      expect(server.items.get(itemId)?.version).toBe(version)
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
    }

    async function expectDelivered(a: Device, b: Device, itemId: ItemId, rows: number, version: number) {
      expect(await a.poll()).toBe('success')
      await a.uploadSnapshots()
      expect(await a.pending()).toEqual([])
      expect(a.services.snapshotManager.tracker.isDirty(itemId)).toBe(false)
      expect(server.rows).toHaveLength(rows + 1)
      expect(server.items.get(itemId)?.version).toBe(version + 1)
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('second')
    }

    it('holds an edit on both while the session is rejected, quarantining nothing, and sends it once it is back', async () => {
      const { a, b, itemId, rows, version } = await editToSend()
      server.rejectsSessions = true

      expect(await a.poll()).toBe('auth-failure')
      expect(await a.uploadSnapshots()).toBeUndefined()
      await expectHeld(a, itemId, rows, version)

      server.rejectsSessions = false
      await expectDelivered(a, b, itemId, rows, version)
    })

    it('holds a push over the log quota as a failed poll, not an auth failure, and the snapshot behind it', async () => {
      const { a, b, itemId, rows, version } = await editToSend()
      server.isOverLogQuota = true

      expect(await a.poll()).toBe('failure')
      await a.uploadSnapshots()
      await expectHeld(a, itemId, rows, version)

      server.isOverLogQuota = false
      await expectDelivered(a, b, itemId, rows, version)
    })

    it('pushes to the log over the storage quota, holding only the snapshot, unquarantined', async () => {
      const { a, b, itemId, rows, version } = await editToSend()
      server.isOverStorageQuota = true

      expect(await a.poll()).toBe('success')
      await a.uploadSnapshots()

      expect(await a.pending()).toEqual([])
      expect(server.rows).toHaveLength(rows + 1)
      expect(a.services.snapshotManager.tracker.isDirty(itemId)).toBe(true)
      expect(server.items.get(itemId)?.version).toBe(version)
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('second')

      server.isOverStorageQuota = false
      await a.uploadSnapshots()
      expect(a.services.snapshotManager.tracker.isDirty(itemId)).toBe(false)
      expect(server.items.get(itemId)?.version).toBe(version + 1)
    })

    it('holds an edit on both while offline, sending nothing, and sends it once back online', async () => {
      const { a, b, itemId, rows, version } = await editToSend()
      // First the server can't be reached, then the device knows it is offline
      server.isDown = true
      expect(await a.poll()).toBe('failure')
      await a.uploadSnapshots()
      await expectHeld(a, itemId, rows, version)
      a.context.setOnlineState(false)
      const pollLog = vi.spyOn(server, 'pollLog')
      const putSnapshots = vi.spyOn(server, 'putSnapshots')

      expect(await a.poll()).toBe('no-poll')
      await a.uploadSnapshots()
      expect(pollLog).not.toHaveBeenCalled()
      expect(putSnapshots).not.toHaveBeenCalled()
      await expectHeld(a, itemId, rows, version)

      server.isDown = false
      a.context.setOnlineState(true)
      await expectDelivered(a, b, itemId, rows, version)
    })
  })

  describe('rule 4: a poll that threw reports failure', () => {
    // A failed snapshot request is logged and retried later, so these fail reading local storage

    it('when healing throws, and heals on the next poll', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'one' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'two' })
      await a.sync()
      await a.edit(itemId, { title: 'three' })
      await a.poll()
      server.loseRow(server.head - 1)
      const later = server.clock() + SYNC_TIMEOUTS.gapWait
      server.clock = () => later
      const heal = vi.spyOn(b.services.gapHealer, 'runDue')
      vi.spyOn(b.services.manifestSyncManager, 'fetchSnapshots').mockRejectedValueOnce(new Error('IndexedDB read failed'))

      expect(await b.poll()).toBe('failure')
      expect(heal).toHaveBeenCalled()
      expect(b.services.puller.cursor).toBe(server.head)

      expect(await b.poll()).toBe('success')
      expect((await b.read(itemId))?.title).toBe('three')
    })

    it('when applying a page throws, and leaves the cursor for the next poll to read it again', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      await b.poll()
      const itemId = await a.create('item-1', { title: 'first' })
      await a.poll()
      vi.spyOn(b.services.snapshotCoverage, 'recordPulledChanges').mockRejectedValueOnce(new Error('IndexedDB write failed'))

      expect(await b.poll()).toBe('failure')

      expect(await b.poll()).toBe('success')
      expect((await b.read(itemId))?.title).toBe('first')
      expect(b.services.puller.cursor).toBe(server.head)
    })
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
      const runPhase = vi.spyOn(b.services.manifestSyncManager, 'runPhase')

      expect(await b.poll()).toBe('success')

      expect(runPhase.mock.calls.filter(([, minMode]) => minMode === 'now')).toHaveLength(1)
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
      const runPhase = vi.spyOn(b.services.manifestSyncManager, 'runPhase')
      expect(await b.poll()).toBe('success')

      expect(runPhase.mock.calls.filter(([, minMode]) => minMode === 'now')).toHaveLength(1)
      expect(b.services.puller.cursor).toBe(server.head)
      expect(b.services.puller.pendingManifestSync).toBeUndefined()
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

  it('strands nothing when a plaintext session seals later', async () => {
    const a = await startDevice('device-a')
    const itemId = await a.create('item-1', { title: 'one' })
    await a.poll()
    await a.edit(itemId, { title: 'two' })
    await a.poll()
    const plaintext = await startDevice('device-b')
    expect(plaintext.context.localStorageState?.mode).toBe('plaintext')
    // A row it can't apply: its parent is in a row it never sees
    server.loseRow(1)
    server.items.clear()
    await plaintext.poll()
    await plaintext.stop()

    const sealed = await startDevice('device-b', {
      config: { upgradeLocalEncryption: true, localKeys: keys },
    })
    expect(sealed.context.localStorageState?.mode).toBe('sealed')
    await a.edit(itemId, { title: 'three' })
    await a.uploadSnapshots()
    await sealed.poll()

    expect((await sealed.read(itemId))?.title).toBe('three')
  })

  describe('sync reset', () => {
    /** Restarts a device as the migration app does, which resets its sync state, against a log that starts empty */
    async function crossTheCut(device: Device, oldHeads?: [ItemId, string[]][]): Promise<void> {
      await device.rewindToOldBuild(oldHeads)
      await device.start()
    }

    function resetLog(): void {
      server.rows = []
      server.head = 0
    }

    function rowItems(): ItemId[] {
      return Array.from(new Set(server.rows.map(row => row.itemId)))
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

      expect(rowItems()).toEqual([itemId])
      const b = await startDevice('device-b')
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('edited on the old build')
    })

    it('pushes the whole history of an item matching its snapshot, and clears its mark', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      resetLog()

      await crossTheCut(a)
      expect(await a.pending()).toEqual([itemId])
      expect(a.services.serverHeads.has(itemId)).toBe(false)
      await a.poll()

      expect(rowItems()).toEqual([itemId])
      expect(await a.pending()).toEqual([])
      expect(a.services.serverHeads.get(itemId)).toEqual(await a.services.docStore.readHeads(itemId))
      server.items.clear()
      const b = await startDevice('device-b')
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('first')
    })

    it('merges the server\'s snapshot before it pushes, so it pushes only what the snapshot lacks', async () => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()
      await a.edit(itemId, { title: 'only in the snapshot' })
      await a.sync()
      await b.edit(itemId, { body: 'from b' })
      await b.settle()
      resetLog()
      const fetchManifest = vi.spyOn(server, 'fetchManifest')
      const pollLog = vi.spyOn(server, 'pollLog')

      await crossTheCut(b)
      expect(await b.poll()).toBe('success')

      const firstPush = pollLog.mock.calls.findIndex(([input]) => (input.push?.length ?? 0) > 0)
      expect(firstPush).toBeGreaterThanOrEqual(0)
      expect(fetchManifest.mock.invocationCallOrder[0]).toBeLessThan(pollLog.mock.invocationCallOrder[firstPush])
      expect(server.rows).toHaveLength(1)
      expect(await b.pending()).toEqual([])
      expect(await b.read(itemId)).toMatchObject({ title: 'only in the snapshot', body: 'from b' })

      await b.sync()
      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      expect(await c.read(itemId)).toMatchObject({ title: 'only in the snapshot', body: 'from b' })
    })

    it('uploads a snapshot for an item the server has none of, once its push has landed', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      resetLog()
      server.items.clear()

      await crossTheCut(a)
      await a.sync()

      expect(server.items.get(itemId)?.version).toBe(1)
      expect(rowItems()).toEqual([itemId])
      expect(a.services.serverHeads.get(itemId)).toEqual(await a.services.docStore.readHeads(itemId))
    })

    it('heals a snapshot uploaded over one whose fetch failed during catch-up', async () => {
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
      await b.edit(itemId, { body: 'from b' })
      await b.sync()
      expect(fetchSnapshots).toHaveBeenCalled()

      // Uploads are last-write-wins: the device holding what the replaced snapshot held uploads it again (S2)
      await a.manifestSync()
      await a.uploadSnapshots()
      await b.manifestSync()
      server.expireLog()
      const c = await startDevice('device-c')
      await c.poll()
      for (const device of [a, b, c]) {
        expect(await device.read(itemId)).toMatchObject({ title: 'only in the snapshot', body: 'from b' })
      }
    })

    it('needs no network for the reset, and pushes once online', async () => {
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
      expect(rowItems()).toEqual([itemId])
    })

    it('leaves a later start alone once the reset has run', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await crossTheCut(a)
      await a.sync()
      const heads = a.services.serverHeads.get(itemId)
      expect(heads).toBeDefined()
      await a.services.serverHeads.save()

      await a.restart()

      expect(a.services.serverHeads.get(itemId)).toEqual(heads)
      expect(await a.pending()).toEqual([])
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

    it('waits for catch-up after the sync reset', async () => {
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
      expect(a.services.itemReencryptor.stage).toBe('waitingForSync')

      await a.poll()

      expect(await run).toEqual({ succeeded: [itemId], failed: [] })
    })

    it('heals a rewrite that replaced another device\'s snapshot', async () => {
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
      await a.poll()
      await a.manifestSync()
      await a.uploadSnapshots()

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
