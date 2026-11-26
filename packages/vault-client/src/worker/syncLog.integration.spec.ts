import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId } from '@vault/shared'
import type { Keyring } from '../keys/Keyring'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { FakeVaultServer } from './__test__/FakeVaultServer'
import { createAccountKeys, Device, installLocalStorage } from './__test__/syncLogHarness'

const DAY = 24 * 60 * 60 * 1000
/** Past the puller's debounce on saving the log cursor */
const LOG_CURSOR_SAVE_DELAY_MS = 1500

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

  it('neither resends nor pulls as another device\'s a push whose poll aborted after the server stored it', async () => {
    const a = await startDevice('device-a')
    await a.poll()
    await a.create('item-1', { title: 'first' })
    await a.settle()
    // As stealing leadership does, with the request already answered
    const controller = new AbortController()
    const pollLog = server.pollLog.bind(server)
    vi.spyOn(server, 'pollLog').mockImplementationOnce(input => {
      const output = pollLog(input)
      controller.abort()
      return output
    })
    const resolveQuarantines = vi.spyOn(a.services.recoveryManager, 'resolveQuarantines')

    expect(await a.services.poller.executePoll(controller.signal)).toBe('no-poll')
    expect(server.head).toBe(1)
    expect(await a.pending()).toEqual([])

    expect(await a.poll()).toBe('success')
    expect(server.head).toBe(1)
    expect(resolveQuarantines).not.toHaveBeenCalled()
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
      expect(b.services.itemSyncState.listUnconfirmedPulls().size).toBe(0)
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
      expect(b.services.itemSyncState.listUnconfirmedPulls().has(itemId)).toBe(true)

      await a.edit(itemId, { deleted: true })
      await a.sync()
      await b.manifestSync()

      expect(server.items.get(itemId)?.deleted).toBe(true)
      expect(b.services.itemSyncState.listUnconfirmedPulls().size).toBe(0)
    })
  })

  describe('switching tabs', () => {
    it.each([
      { clean: true, label: 'stops' },
      { clean: false, label: 'was frozen' },
    ])('pushes an edit made just before the switch from the new tab, when the old one $label', async ({ clean }) => {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await b.sync()

      await a.edit(itemId, { title: 'just before the switch' })
      await a.settle()
      // A frozen tab is closed with only what it had stored: the doc, and the mark written with the edit
      if (!clean) await a.flushDocs([itemId])
      expect(await a.pending()).toEqual([itemId])

      await a.takeOver({ clean })
      await a.poll()
      await b.poll()

      expect((await b.read(itemId))?.title).toBe('just before the switch')
      expect(await a.pending()).toEqual([])
    })

    it.each([
      { clean: true, label: 'stops' },
      { clean: false, label: 'was frozen' },
    ])('uploads the snapshots the old tab owed, when it $label', async ({ clean }) => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.edit(itemId, { title: 'second' })
      await a.poll()
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(true)
      expect(server.items.get(itemId)?.version).toBe(1)

      await a.takeOver({ clean })

      // The new tab's startup audit finds the dirty flag the acknowledgement saved
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(true)
      await a.uploadSnapshots()
      expect(server.items.get(itemId)?.version).toBe(2)
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(false)
    })

    it(`keeps the new tab's cursor and base versions through a late write from the displaced one`, async () => {
      const displaced = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await displaced.create('item-1', { title: 'first' })
      await displaced.sync()
      await b.sync()
      await new Promise(resolve => setTimeout(resolve, LOG_CURSOR_SAVE_DELAY_MS))

      // The old tab pulls a row, and is frozen before its debounced save of the cursor runs
      await b.edit(itemId, { title: 'second' })
      await b.poll()
      await displaced.poll()
      const staleCursor = displaced.services.puller.cursor

      // The new tab takes over on the same storage and moves on past the old one
      const active = await startDevice('device-a')
      await b.edit(itemId, { title: 'third' })
      await b.sync()
      await active.poll()
      await active.manifestSync()
      await new Promise(resolve => setTimeout(resolve, LOG_CURSOR_SAVE_DELAY_MS))
      const cursor = active.services.puller.cursor
      const baseVersion = active.services.itemSyncState.getBaseVersion(itemId)
      expect(cursor).toBeGreaterThan(staleCursor)
      expect(baseVersion).toBe(server.items.get(itemId)?.version)

      // The old tab thaws, handles the takeover, and saves what it had as it stops
      await displaced.stop()

      expect(active.services.puller.cursor).toBe(cursor)
      expect(active.services.itemSyncState.getBaseVersion(itemId)).toBe(baseVersion)
      await active.services.itemSyncState.save()
      // The next row moves the stored cursor past the stale one again
      await b.edit(itemId, { title: 'fourth' })
      await b.poll()
      await active.poll()
      await active.stop()

      const reopened = await startDevice('device-a')
      expect(reopened.services.puller.cursor).toBe(server.head)
      expect(reopened.services.itemSyncState.getBaseVersion(itemId)).toBe(baseVersion)
      expect((await reopened.read(itemId))?.title).toBe('fourth')
      expect(await reopened.pending()).toEqual([])
      expect(await reopened.quarantined()).toEqual([])
    })
  })

  describe('dirty on acknowledgement', () => {
    it(`pushes and uploads a leader's unpushed edit before counting unsynced changes`, async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      const version = server.items.get(itemId)!.version
      await a.edit(itemId, { title: 'second' })
      await a.settle()
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(false)

      expect(await a.context.getUnsyncedChanges()).toEqual({ pendingItems: 0, quarantinedItems: 0 })
      expect(server.items.get(itemId)?.version).toBe(version + 1)
    })

    it('keeps an acknowledged item pending when its records fail to save, and snapshots it after a crash', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      const version = server.items.get(itemId)!.version
      await a.edit(itemId, { title: 'second' })
      await a.settle()
      const rows = server.rows.length

      a.failNextStateSave()
      await a.poll()
      expect(server.rows).toHaveLength(rows + 1)
      expect(await a.pending()).toEqual([itemId])

      await a.crash()
      await a.start()
      expect(await a.pending()).toEqual([itemId])

      await a.sync()
      expect(await a.pending()).toEqual([])
      expect(server.items.get(itemId)?.version).toBe(version + 1)
      server.expireLog()
      const b = await startDevice('device-b')
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('second')
    })

    it('keeps an acknowledged edit pending until its doc is stored', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      const rows = server.rows.length

      // The doc can't be stored (a full disk, say) while the edit is pushed and the cursor's save comes due
      a.failDocWrites()
      await a.edit(itemId, { title: 'second' })
      await a.poll()
      expect(server.rows).toHaveLength(rows + 1)
      expect(await a.pending()).toEqual([itemId])
      await new Promise(resolve => setTimeout(resolve, LOG_CURSOR_SAVE_DELAY_MS))
      await a.crash()
      await a.start()

      // The mark stayed, and the cursor stayed before the device's own row, so it reads the row back
      expect((await a.read(itemId))?.title).toBe('first')
      expect(await a.pending()).toEqual([itemId])
      expect(a.services.puller.cursor).toBeLessThan(server.head)
      await a.sync()
      expect((await a.read(itemId))?.title).toBe('second')
      expect(await a.pending()).toEqual([])

      // The snapshot it uploads holds the edit
      server.expireLog()
      const b = await startDevice('device-b')
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('second')
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
      // Only the push's acknowledgement makes the item owe a snapshot
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(false)
      expect(server.rows).toHaveLength(rows)
      expect(server.items.get(itemId)?.version).toBe(version)
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
    }

    async function expectDelivered(a: Device, b: Device, itemId: ItemId, rows: number, version: number) {
      expect(await a.poll()).toBe('success')
      await a.uploadSnapshots()
      expect(await a.pending()).toEqual([])
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(false)
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
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(true)
      expect(server.items.get(itemId)?.version).toBe(version)
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
      await b.poll()
      expect((await b.read(itemId))?.title).toBe('second')

      server.isOverStorageQuota = false
      await a.uploadSnapshots()
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(false)
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
      const heal = vi.spyOn(b.services.itemReconciler, 'runDue')
      vi.spyOn(b.services.manifestHydrator, 'fetchSnapshots').mockRejectedValueOnce(new Error('IndexedDB read failed'))

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
      vi.spyOn(b.services.itemSyncState, 'recordPulledChanges').mockRejectedValueOnce(new Error('IndexedDB write failed'))

      expect(await b.poll()).toBe('failure')

      expect(await b.poll()).toBe('success')
      expect((await b.read(itemId))?.title).toBe('first')
      expect(b.services.puller.cursor).toBe(server.head)
    })
  })

  describe('replacing an item from the server', () => {
    /** B holds two items A created, and the server's copy of `broken` no longer decrypts */
    async function startWithBrokenItem() {
      const a = await startDevice('device-a')
      const b = await startDevice('device-b')
      const itemId = await a.create('item-1', { title: 'from the server' })
      const broken = await a.create('item-2', { title: 'broken' })
      await a.sync()
      await b.sync()
      await b.manifestSync()
      const stored = server.items.get(broken)!
      const cipher = stored.snapshot!.cipher
      stored.snapshot = { ...stored.snapshot!, cipher: `${cipher[0] === 'A' ? 'B' : 'A'}${cipher.slice(1)}` }
      await b.services.recoveryManager.quarantine(
        broken,
        'snapshotDecryption',
        { code: 'decryptionFailed' },
        { serverVersion: stored.version },
      )
      // An unreadable copy never loads, so B starts again with neither doc in memory
      await b.restart()
      return { b, itemId, broken }
    }

    it('restores the item though another quarantined item fails to download', async () => {
      const { b, itemId, broken } = await startWithBrokenItem()
      await b.services.recoveryManager.quarantine(itemId, 'localDecryption', { code: 'decryptionFailed' })

      await b.services.itemRecoveryService.replaceFromServer(itemId)

      expect((await b.read(itemId))?.title).toBe('from the server')
      expect(await b.quarantined()).toEqual([broken])
    })

    it('keeps the item quarantined when its own copy fails to download', async () => {
      const { b, broken } = await startWithBrokenItem()

      await expect(b.services.itemRecoveryService.replaceFromServer(broken)).rejects.toThrow(/could not be downloaded/)

      expect(await b.quarantined()).toEqual([broken])
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
    a.services.snapshotSchedule.markItemDirty(itemId)
    await a.poll()
    await a.uploadSnapshots()

    expect(server.rows).toHaveLength(rows)
    await a.poll()
    expect(await a.pending()).toEqual([])

    await b.manifestSync()
    expect((await b.read(itemId))?.blob).toBeInstanceOf(Uint8Array)
  })

  // Its base version would otherwise say the device has what a crash would leave its doc without
  it('uploads a snapshot only once its doc is stored', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    const itemId = await a.create('item-1', { title: 'first' })
    await a.sync()
    await b.sync()
    const version = server.items.get(itemId)!.version

    const allowDocWrites = a.failDocWrites()
    await a.services.docStore.changeDocument(itemId, draft => {
      draft.blob = randomBytes(MAX_INCREMENTAL_MESSAGE_BYTES + 1024)
    })
    await a.services.changeOutbox.mark(itemId)
    a.services.snapshotSchedule.markItemDirty(itemId)
    await a.poll()
    await a.uploadSnapshots()
    expect(server.items.get(itemId)?.version).toBe(version)
    expect(a.services.itemSyncState.getBaseVersion(itemId)).toBe(version)
    expect(await a.pending()).toEqual([itemId])

    allowDocWrites()
    await a.uploadSnapshots()
    expect(server.items.get(itemId)?.version).toBe(version + 1)
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
      const fetchManifest = vi.spyOn(server, 'fetchManifest')

      // The server's clock shows B is behind, so it drops the page, catches up and reads again at once
      expect(await b.poll()).toBe('success')
      expect(b.services.puller.hasImmediatePendingPulls()).toBe(true)
      expect(await b.poll()).toBe('success')

      expect(fetchManifest).toHaveBeenCalledTimes(1)
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
      const fetchManifest = vi.spyOn(server, 'fetchManifest')
      expect(await b.poll()).toBe('success')

      expect(fetchManifest).toHaveBeenCalledTimes(1)
      expect(b.services.puller.cursor).toBe(server.head)
      expect(b.services.manifestSyncManager.getDueAt()).not.toBe(Date.now())
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
      expect(a.services.itemSyncState.hasServerHeads(itemId)).toBe(false)
      await a.poll()

      expect(rowItems()).toEqual([itemId])
      expect(await a.pending()).toEqual([])
      expect(a.services.itemSyncState.getServerHeads(itemId)).toEqual(await a.services.docStore.readHeads(itemId))
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
      expect(a.services.itemSyncState.getServerHeads(itemId)).toEqual(await a.services.docStore.readHeads(itemId))
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
      const heads = a.services.itemSyncState.getServerHeads(itemId)
      expect(heads).toBeDefined()
      await a.services.itemSyncState.save()

      await a.restart()

      expect(a.services.itemSyncState.getServerHeads(itemId)).toEqual(heads)
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

      const result = await a.services.snapshotRewriter.request()

      expect(result).toEqual({ succeeded: [itemId], failed: [] })
      expect(server.rows.length).toBe(rows + 1)
      expect(await a.services.recoveryManager.listRecoveryItems()).toEqual([])
    })

    it('uploads an item edited during a rewrite at most once more afterwards', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      const version = server.items.get(itemId)!.version
      const { changeOutbox } = a.services
      const pushItems = changeOutbox.pushItems.bind(changeOutbox)
      vi.spyOn(changeOutbox, 'pushItems').mockImplementationOnce(async (itemIds, signal) => {
        await a.edit(itemId, { title: 'during the rewrite' })
        await a.settle()
        return pushItems(itemIds, signal)
      })

      expect(await a.services.snapshotRewriter.request()).toEqual({ succeeded: [itemId], failed: [] })
      expect(server.items.get(itemId)?.version).toBe(version + 1)

      await a.sync()
      await a.sync()

      expect(server.items.get(itemId)?.version).toBeLessThanOrEqual(version + 2)
      expect(await a.pending()).toEqual([])
      expect(a.services.itemSyncState.isDirty(itemId)).toBe(false)
    })

    it('waits for catch-up after the sync reset', async () => {
      const a = await startDevice('device-a')
      const itemId = await a.create('item-1', { title: 'first' })
      await a.sync()
      await a.rewindToOldBuild()
      await a.start()

      let finished = false
      const run = a.services.snapshotRewriter.request().then(result => {
        finished = true
        return result
      })
      await a.settle()
      expect(finished).toBe(false)
      expect(a.services.snapshotRewriter.stage).toBe('waitingForSync')

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

      await b.services.snapshotRewriter.request()
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
    expect(a.services.itemSyncState.isDirty(itemId)).toBe(true)
  })
})
