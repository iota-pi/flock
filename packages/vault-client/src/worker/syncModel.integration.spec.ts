import * as fc from 'fast-check'
import { SYNC_LOG_TTL_DAYS, type ItemId } from '@vault/shared'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { fence } from './__test__/crashFence'
import { Device } from './__test__/syncLogHarness'
import {
  assertConverged,
  CloseTab,
  commandArbitrary,
  Crash,
  Create,
  createWorld,
  destroyWorld,
  Edit,
  FailStateSave,
  Idle,
  LoseResponse,
  OpenTab,
  Poll,
  quiesce,
  runScenario,
  Steal,
  Store,
  UploadSnapshots,
  type Model,
  type World,
} from './__test__/syncModel'

const DAY = 24 * 60 * 60 * 1000
/** Past the puller's debounce on saving the log cursor */
const LOG_CURSOR_SAVE_DELAY_MS = 1500

/**
 * Random operations on several devices sharing one server, then a check that they converged and lost
 * nothing (see `__test__/syncModel.ts`). A failure prints the seed and path that replay it, and the
 * shrunk list of operations.
 *
 * - `SYNC_MODEL_SEED`, `SYNC_MODEL_PATH` and `SYNC_MODEL_REPLAY_PATH` (the `replayPath` in the
 *   counterexample) replay a reported failure. `SYNC_MODEL_SHRINK_MS` gives shrinking longer.
 * - `SYNC_MODEL_RUNS` runs more (or fewer) random scenarios.
 *
 * CI runs this file in its own job (`yarn test:sync-model`) with the fixed seed below, so a PR only
 * fails on scenarios that already passed on master. The nightly Sync Model Exploration workflow
 * tries a random seed with many more runs.
 */
const DEVICES = 3
const SEED = Number(process.env.SYNC_MODEL_SEED ?? 0x5eed)
const PATH = process.env.SYNC_MODEL_PATH
const REPLAY_PATH = process.env.SYNC_MODEL_REPLAY_PATH
const RUNS = Number(process.env.SYNC_MODEL_RUNS ?? 20)
/** Shrinking re-runs whole scenarios, so it stops here and reports the smallest failure it has */
const SHRINK_TIME_LIMIT = Number(process.env.SYNC_MODEL_SHRINK_MS ?? 2 * 60 * 1000)
/** A scenario takes a few seconds on a CI runner, so this leaves room for slow ones, then shrinking */
const TIMEOUT = Math.max(10 * 60 * 1000, RUNS * 15 * 1000 + SHRINK_TIME_LIMIT)

describe('sync model', () => {
  it('converges, losing nothing a device stored, whatever the devices do', { timeout: TIMEOUT }, async () => {
    const commands = fc.commands([commandArbitrary(DEVICES)], { maxCommands: 60, size: 'max', replayPath: REPLAY_PATH })
    // Each scenario checks itself, and throws (failing the property) if anything didn't converge
    await expect(fc.assert(
      fc.asyncProperty(commands, scenario => runScenario(DEVICES, scenario)),
      {
        seed: SEED,
        path: PATH,
        numRuns: RUNS,
        plugins: [fc.interruptAfterTimeLimit(SHRINK_TIME_LIMIT, { failOnInterrupt: true })],
      },
    )).resolves.toBeUndefined()
  })

  it('converges through follower tabs, a steal, a lost response and a failed save', { timeout: 60_000 }, async () => {
    // Every command the random runs pick from only rarely, in one fixed scenario. It checks itself.
    await expect(runScenario(2, [
      new Create(0),
      new Poll(0),
      new OpenTab(0),
      new Edit(0, 0, true),
      new Create(0, true),
      new Store(0),
      new LoseResponse(),
      new Poll(0),
      new FailStateSave(0),
      new Poll(0),
      new Steal(0),
      new Edit(0, 1, true),
      new Edit(0, 0),
      new Poll(0),
      new UploadSnapshots(0),
      new Poll(1),
      new CloseTab(0),
      new OpenTab(1),
      new Edit(1, 1, true),
      new Crash(1, 'none', 0),
      new Poll(1),
    ])).resolves.toBeUndefined()
  })

  // A crash lost an acknowledged edit from its author's doc, whose log cursor had moved past the row
  it('keeps an acknowledged edit through a crash before the Repo stores its doc', { timeout: 60_000 }, async () => {
    await expect(runScenario(1, [
      new Create(0),
      new Poll(0),
      new Edit(0, 0),
      new Poll(0),
      new Idle(),
      new Crash(0, 'none', 0),
    ])).resolves.toBeUndefined()
  })

  describe('regressions', () => {
    let world: World | undefined
    const observers: Device[] = []

    afterEach(async () => {
      if (world) await destroyWorld(world, observers.splice(0))
      world = undefined
    })

    /** Device A creates an item and syncs, then the log expires, so only the snapshot holds it */
    async function snapshotOnlyItem() {
      const setup = await createWorld(1)
      world = setup.real
      const [a] = world.devices
      const itemId = await a.create('item-1')
      await a.sync()
      world.server.expireLog()
      world.clockOffset += SYNC_TIMEOUTS.gapWait
      const b = await new Device('device-b', world.server, world.keys).start()
      world.devices.push(b)
      return { setup, a, b, itemId }
    }

    it('stores a hydrated doc before recording its base version', async () => {
      const { setup, a, b, itemId } = await snapshotOnlyItem()
      // B catches up from the snapshot, and dies just after hydration records its version
      const state = b.services.itemSyncState
      const importBaseVersions = state.importBaseVersions.bind(state)
      const spy = vi.spyOn(state, 'importBaseVersions').mockImplementation(async updates => {
        await importBaseVersions(updates)
        fence(b.name)
      })
      await b.poll()
      expect(spy).toHaveBeenCalledWith([[itemId, 1]])
      await b.crash()
      await b.start()
      // The doc reached storage first
      expect(await b.liveIds()).toEqual([itemId])
      expect(await b.heads(itemId)).toEqual(await a.heads(itemId))

      await quiesce(world!, setup.model)
      await assertConverged(world!, setup.model, observers)
    })

    it('fetches a hydrated snapshot again after a crash before its doc was stored', async () => {
      const { setup, a, b, itemId } = await snapshotOnlyItem()
      // B catches up from the snapshot, and dies as hydration starts to store the doc
      const docStore = b.services.docStore
      const flushToStorage = docStore.flushToStorage.bind(docStore)
      const spy = vi.spyOn(docStore, 'flushToStorage').mockImplementation(async ids => {
        if (ids.includes(itemId)) fence(b.name)
        await flushToStorage(ids)
      })
      await b.poll()
      expect(spy).toHaveBeenCalledWith([itemId])
      await b.crash()
      await b.start()
      // Nothing says B has the item, so the next manifest sync fetches it
      expect(await b.heads(itemId)).toBeNull()
      expect(b.services.itemSyncState.getBaseVersion(itemId)).toBe(0)

      await quiesce(world!, setup.model)
      expect(await b.heads(itemId)).toEqual(await a.heads(itemId))
      await assertConverged(world!, setup.model, observers)
    })

    /** Two devices that both hold one item, which the model knows A stored */
    async function sharedItem() {
      const setup = await createWorld(2)
      world = setup.real
      const [a, b] = world.devices
      const itemId = await a.create('item-1')
      await a.sync()
      await b.sync()
      setup.model.items.push(itemId)
      setup.model.durableCreates.add(itemId)
      return { setup, world, a, b, itemId }
    }

    function recordStoredEdit(model: Model, itemId: ItemId, key: string): void {
      model.durableEdits.set(itemId, new Set([...(model.durableEdits.get(itemId) ?? []), key]))
    }

    it('never moves server heads back to a stale snapshot it hydrates', async () => {
      const { setup, world: w, a, b, itemId } = await sharedItem()
      await a.edit(itemId, { e1: 1 })
      await a.poll()
      await a.uploadSnapshots()
      await a.flushDocs([itemId])
      recordStoredEdit(setup.model, itemId, 'e1')
      const pushedHeads = a.services.itemSyncState.getServerHeads(itemId)
      expect(pushedHeads).toEqual(await a.heads(itemId))

      // B uploads a later snapshot that lacks A's edit, and A merges it before pulling B's row
      w.server.hiddenSeqs.add(w.server.head)
      try {
        await b.edit(itemId, { e2: 2 })
        await b.poll()
        await b.uploadSnapshots()
        await b.flushDocs([itemId])
        recordStoredEdit(setup.model, itemId, 'e2')
        w.server.hiddenSeqs.add(w.server.head)
        await a.manifestSync()
      } finally {
        w.server.hiddenSeqs.clear()
      }
      expect(await a.read(itemId)).toMatchObject({ e1: 1, e2: 2 })

      // A's server heads cover its edit and the snapshot, so it has nothing to send again
      expect([...a.services.itemSyncState.getServerHeads(itemId)].sort()).toEqual([...(await a.heads(itemId))!].sort())
      const pollLog = vi.spyOn(w.server, 'pollLog')
      await a.poll()
      expect(pollLog.mock.calls.flatMap(([input]) => input.push)).toEqual([])

      await quiesce(w, setup.model)
      await assertConverged(w, setup.model, observers)
    })

    it('stores pulled docs before the log cursor moves past them', async () => {
      const { setup, world: w, a, b, itemId } = await sharedItem()
      await a.edit(itemId, { e1: 1 })
      await a.poll()
      await a.flushDocs([itemId])
      recordStoredEdit(setup.model, itemId, 'e1')

      // B's doc store fails (a full disk, say) while it pulls the edit and its cursor save comes due
      const saveDoc = vi.spyOn(b.services.repoManager.repo.storageSubsystem!, 'saveDoc')
        .mockRejectedValue(new Error('disk full'))
      await b.poll()
      expect(await b.read(itemId)).toMatchObject({ e1: 1 })
      await new Promise(resolve => setTimeout(resolve, LOG_CURSOR_SAVE_DELAY_MS))
      expect(saveDoc).toHaveBeenCalled()
      await b.crash()
      await b.start()

      // The cursor stayed before the row, so the next poll pulls it again
      expect(b.services.puller.cursor).toBeLessThan(w.server.head)
      await b.poll()
      expect(await b.heads(itemId)).toEqual(await a.heads(itemId))

      await quiesce(w, setup.model)
      await assertConverged(w, setup.model, observers)
    })

    it('keeps a lost row\'s manifest sync due, failing polls, until one fetches the manifest', async () => {
      const { setup, world: w, a, b, itemId } = await sharedItem()
      await a.edit(itemId, { e1: 1 })
      await a.poll()
      await a.edit(itemId, { e2: 2 })
      await a.poll()
      await a.flushDocs([itemId])
      recordStoredEdit(setup.model, itemId, 'e1')
      recordStoredEdit(setup.model, itemId, 'e2')
      w.server.loseRow(w.server.head - 1)
      // The row after the gap is old enough that the missing one can't still be in flight
      w.clockOffset += SYNC_TIMEOUTS.gapWait

      const fetchManifest = vi.spyOn(w.server, 'fetchManifest').mockImplementation(() => {
        throw new Error('manifest unavailable')
      })
      const recoveryDue = () => b.services.manifestDemands.isDemanded(b.services.puller.recoveryDemand)
      expect(await b.poll()).toBe('failure')
      expect(recoveryDue()).toBe(true)
      expect(await b.poll()).toBe('failure')
      expect(recoveryDue()).toBe(true)

      fetchManifest.mockRestore()
      expect(await b.poll()).toBe('success')
      expect(recoveryDue()).toBe(false)

      await quiesce(w, setup.model)
      await assertConverged(w, setup.model, observers)
    })

    it('never resurrects an item when a late snapshot races its pulled delete', async () => {
      const { setup, world: w, a, b, itemId } = await sharedItem()
      await a.edit(itemId, { e1: 1 })
      await b.edit(itemId, { deleted: true })
      await b.sync()
      await b.flushDocs([itemId])
      setup.model.durableDeletes.add(itemId)

      // A pushes its edit and uploads its live snapshot before it can see the delete
      const deleteSeq = w.server.head
      w.server.hiddenSeqs.add(deleteSeq)
      await a.poll()
      await a.uploadSnapshots()
      w.server.hiddenSeqs.clear()

      await quiesce(w, setup.model)
      expect(await a.liveIds()).not.toContain(itemId)
      expect(await b.liveIds()).not.toContain(itemId)
      await assertConverged(w, setup.model, observers)
    })

    // Found by the property (seed 24301, path 12:3:4:4:7:9:14:19:20:14:14, replay path AAArA///B:qH).
    // A parks C's delete row, whose create row expired, and the server's tombstone has no snapshot to
    // supply it, so the GapHealer must drop the row once the item is a tombstone, not quarantine it.
    it('quarantines nothing when an item\'s create row expires before its delete is pushed', async () => {
      const setup = await createWorld(3)
      world = setup.real
      const [a, , c] = world.devices
      const itemId = await c.create('item-1')
      setup.model.items.push(itemId)
      await c.poll()
      await c.edit(itemId, { deleted: true })
      await c.settle()
      world.clockOffset += SYNC_LOG_TTL_DAYS * DAY
      world.server.expireLog()
      await a.poll()

      await quiesce(world, setup.model)
      expect(await a.quarantined()).toEqual([])
      await assertConverged(world, setup.model, observers)
    })

    // Found by the property (seed 24301, path 10:4:4:2:4:4:23:28:30:5:17:1:4:7:7, replay path
    // 5AFABA/OABA//u:VrD). Creating an item stored its index entry at once but left its doc to the
    // Repo's throttled save, so a crash in between left C listing an item it had no doc for.
    it('never indexes a created item whose doc a crash lost', async () => {
      const setup = await createWorld(3)
      world = setup.real
      const [a, , c] = world.devices
      const itemId = await c.create('item-1')
      await c.crash()
      await c.start()
      // The create counts as stored once it returns, so the item survives the crash
      expect(await c.liveIds()).toEqual([itemId])
      expect(await c.heads(itemId)).not.toBeNull()
      setup.model.items.push(itemId)
      setup.model.durableCreates.add(itemId)
      await a.poll()

      await quiesce(world, setup.model)
      expect(await a.liveIds()).toEqual([itemId])
      await assertConverged(world, setup.model, observers)
    })

    it('keeps an edit whose author never returns, once the log has expired', async () => {
      const { setup, world: w, a, b, itemId } = await sharedItem()
      await a.edit(itemId, { e1: 1 })
      await a.poll()
      await a.stop()
      w.devices = [b]
      await b.poll()
      expect(await b.read(itemId)).toMatchObject({ e1: 1 })
      await b.flushDocs([itemId])
      recordStoredEdit(setup.model, itemId, 'e1')

      // Only B holds the edit once the log has gone, so B must upload it after the author's grace
      w.clockOffset += SYNC_LOG_TTL_DAYS * DAY
      w.server.expireLog()
      await quiesce(w, setup.model)
      expect(w.server.items.get(itemId)?.version).toBeGreaterThan(1)
      // Including an observer that syncs from snapshots alone
      await assertConverged(w, setup.model, observers)
    })
  })
})
