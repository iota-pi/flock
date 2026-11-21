import * as fc from 'fast-check'
import { SYNC_LOG_TTL_DAYS, type ItemId } from '@vault/shared'
import type { Keyring } from '../../keys/Keyring'
import { SYNC_TIMEOUTS } from '../../shared/syncConfig'
import { FakeVaultServer } from './FakeVaultServer'
import { createAccountKeys, Device, installLocalStorage } from './syncLogHarness'

/**
 * A model-based test of the sync engine: random operations on several devices sharing one fake server,
 * then a check that everything converged without losing anything. See sync-review finding 4.
 *
 * Each edit writes its own key (`e<n>: n`), so no two edits conflict and the merged doc is known
 * without modelling Automerge's conflict rules.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const LOG_TTL = SYNC_LOG_TTL_DAYS * DAY
const DEVICE_NAMES = ['device-a', 'device-b', 'device-c', 'device-d'] as const
const EDIT_KEY = /^e\d+$/
/** Rounds a quiesce may take before the system counts as not converging */
const MAX_QUIESCE_ROUNDS = 8

/** What must be true of the system, as far as the operations so far say */
export interface Model {
  readonly deviceCount: number
  /** Every item created, in order */
  items: ItemId[]
  nextItem: number
  nextEdit: number
  /** What each device has done that it may not have stored yet, so that a crash may lose it */
  unstored: Map<number, Change[]>
  /** Edits that must survive, by item */
  durableEdits: Map<ItemId, Set<string>>
  durableCreates: Set<ItemId>
  durableDeletes: Set<ItemId>
}

type Change =
  | { kind: 'create'; itemId: ItemId }
  | { kind: 'edit'; itemId: ItemId; key: string }
  | { kind: 'delete'; itemId: ItemId }

/** The system under test: one fake server, the devices on it, and the clock they all read */
export interface World {
  server: FakeVaultServer
  keys: Keyring
  devices: Device[]
  /** Added to real time, to jump the clock forward */
  clockOffset: number
}

type SyncCommand = fc.AsyncCommand<Model, World>

// Read once, before any test spies on `Date.now`
const realStart = Date.now()
const perfStart = performance.now()

/** Time runs on as it really does, plus every jump the world has made */
function now(world: World): number {
  return realStart + (performance.now() - perfStart) + world.clockOffset
}

/** Waits for the work an operation left running in the background (writes, fire-and-forget calls) */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** Runs an operation as `device`, with the server answering it only if the device is online */
async function as<T>(world: World, device: Device, operation: () => Promise<T>): Promise<T> {
  world.server.isDown = !device.isOnline
  try {
    const result = await operation()
    await settle()
    return result
  } finally {
    world.server.isDown = false
  }
}

function deviceName(index: number): string {
  return DEVICE_NAMES[index]
}

function record(model: Model, device: number, change: Change): void {
  const list = model.unstored.get(device) ?? []
  list.push(change)
  model.unstored.set(device, list)
}

/** The device's changes are in its storage now, so nothing may lose them */
function markStored(model: Model, device: number): void {
  for (const change of model.unstored.get(device) ?? []) {
    if (change.kind === 'create') model.durableCreates.add(change.itemId)
    if (change.kind === 'delete') model.durableDeletes.add(change.itemId)
    if (change.kind === 'edit') {
      const keys = model.durableEdits.get(change.itemId) ?? new Set()
      keys.add(change.key)
      model.durableEdits.set(change.itemId, keys)
    }
  }
  model.unstored.delete(device)
}

/** The items the device has changed but may not have stored */
function unstoredItems(model: Model, device: number): ItemId[] {
  return Array.from(new Set((model.unstored.get(device) ?? []).map(change => change.itemId)))
}

// ---------------------------------------------------------------------------------------------------
// Commands

abstract class DeviceCommand implements SyncCommand {
  constructor(readonly device: number) {}

  check(model: Readonly<Model>): boolean {
    return this.device < model.deviceCount
  }

  abstract run(model: Model, world: World): Promise<void>
  abstract toString(): string
}

/** Picks an item by an index that shrinks well whatever the number of items */
function pickItem(model: Readonly<Model>, index: number): ItemId {
  return model.items[index % model.items.length]
}

export class Create extends DeviceCommand {
  async run(model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    const itemId = `item-${model.nextItem}`
    model.nextItem += 1
    await as(world, device, () => device.create(itemId))
    model.items.push(itemId as ItemId)
    record(model, this.device, { kind: 'create', itemId: itemId as ItemId })
  }

  toString(): string {
    return `create(${deviceName(this.device)})`
  }
}

export class Edit extends DeviceCommand {
  constructor(device: number, readonly item: number) {
    super(device)
  }

  check(model: Readonly<Model>): boolean {
    return super.check(model) && model.items.length > 0
  }

  async run(model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    const itemId = pickItem(model, this.item)
    // Only an item the device holds, and hasn't deleted, can be edited
    if (!(await device.liveIds()).includes(itemId)) return
    const key = `e${model.nextEdit}`
    model.nextEdit += 1
    await as(world, device, () => device.edit(itemId, { [key]: model.nextEdit }))
    record(model, this.device, { kind: 'edit', itemId, key })
  }

  toString(): string {
    return `edit(${deviceName(this.device)}, item#${this.item})`
  }
}

export class Delete extends DeviceCommand {
  constructor(device: number, readonly item: number) {
    super(device)
  }

  check(model: Readonly<Model>): boolean {
    return super.check(model) && model.items.length > 0
  }

  async run(model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    const itemId = pickItem(model, this.item)
    if (!(await device.liveIds()).includes(itemId)) return
    await as(world, device, () => device.edit(itemId, { deleted: true }))
    record(model, this.device, { kind: 'delete', itemId })
  }

  toString(): string {
    return `delete(${deviceName(this.device)}, item#${this.item})`
  }
}

export class Poll extends DeviceCommand {
  async run(_model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    await as(world, device, () => device.poll())
  }

  toString(): string {
    return `poll(${deviceName(this.device)})`
  }
}

export class UploadSnapshots extends DeviceCommand {
  async run(_model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    await as(world, device, () => device.uploadSnapshots())
  }

  toString(): string {
    return `uploadSnapshots(${deviceName(this.device)})`
  }
}

export class ManifestSync extends DeviceCommand {
  async run(_model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    try {
      await as(world, device, () => device.manifestSync())
    } catch (error) {
      // A device that knows no items yet has no local data to fall back on, so it throws offline
      if (device.isOnline) throw error
    }
  }

  toString(): string {
    return `manifestSync(${deviceName(this.device)})`
  }
}

/** Stores what the device changed, as the Repo's throttled save eventually does */
export class Store extends DeviceCommand {
  async run(model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    await device.flushDocs(unstoredItems(model, this.device))
    markStored(model, this.device)
  }

  toString(): string {
    return `store(${deviceName(this.device)})`
  }
}

export class SetOnline extends DeviceCommand {
  constructor(device: number, readonly isOnline: boolean) {
    super(device)
  }

  async run(_model: Model, world: World): Promise<void> {
    world.devices[this.device].setOnline(this.isOnline)
  }

  toString(): string {
    return `${this.isOnline ? 'online' : 'offline'}(${deviceName(this.device)})`
  }
}

/** Closes the app and opens it again, which stores everything first */
export class Restart extends DeviceCommand {
  async run(model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    const isOnline = device.isOnline
    await device.restart()
    device.setOnline(isOnline)
    markStored(model, this.device)
  }

  toString(): string {
    return `restart(${deviceName(this.device)})`
  }
}

type InFlight = 'none' | 'poll' | 'upload' | 'manifestSync'

/** The tab dies, maybe in the middle of an operation, and the app is opened again */
export class Crash extends DeviceCommand {
  constructor(device: number, readonly during: InFlight, readonly ticks: number) {
    super(device)
  }

  async run(model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    const isOnline = device.isOnline
    world.server.isDown = !isOnline
    const operation = this.startOperation(device)
    for (let i = 0; i < this.ticks; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    await device.crash(operation)
    world.server.isDown = false
    // Whatever it hadn't stored may be lost, so nothing more is known of it
    model.unstored.delete(this.device)
    await device.start()
    device.setOnline(isOnline)
  }

  private startOperation(device: Device): Promise<unknown> | undefined {
    switch (this.during) {
      case 'poll': return device.poll()
      case 'upload': return device.uploadSnapshots()
      case 'manifestSync': return device.manifestSync()
      default: return undefined
    }
  }

  toString(): string {
    const during = this.during === 'none' ? '' : `, during ${this.during} after ${this.ticks} ticks`
    return `crash(${deviceName(this.device)}${during})`
  }
}

export class AdvanceClock implements SyncCommand {
  constructor(readonly ms: number) {}

  check(): boolean {
    return true
  }

  async run(_model: Model, world: World): Promise<void> {
    world.clockOffset += this.ms
  }

  toString(): string {
    const name = Object.entries(SYNC_TIMEOUTS).find(([, value]) => value === this.ms)?.[0]
    return `advanceClock(${name ?? `${this.ms}ms`})`
  }
}

/** Time passes beyond the log's TTL, and the server drops the rows that have expired */
export class ExpireLog implements SyncCommand {
  check(): boolean {
    return true
  }

  async run(_model: Model, world: World): Promise<void> {
    world.clockOffset += LOG_TTL
    expireOldRows(world)
  }

  toString(): string {
    return 'expireLog()'
  }
}

function expireOldRows(world: World): void {
  const cutoff = now(world) - LOG_TTL
  const expired = world.server.rows.filter(row => row.createdAt < cutoff)
  if (expired.length > 0) {
    world.server.expireLog(Math.max(...expired.map(row => row.seq)))
  }
}

/** The server loses a row, as it would if the row never became visible */
export class LoseRow implements SyncCommand {
  constructor(readonly row: number) {}

  check(): boolean {
    return true
  }

  async run(_model: Model, world: World): Promise<void> {
    const { rows } = world.server
    if (rows.length === 0) return
    world.server.loseRow(rows[this.row % rows.length].seq)
  }

  toString(): string {
    return `loseRow(#${this.row})`
  }
}

/** The device polls while the newest row isn't visible yet, as part of a transaction may not be */
export class PollWithHiddenHead extends DeviceCommand {
  async run(_model: Model, world: World): Promise<void> {
    const device = world.devices[this.device]
    world.server.hiddenSeqs.add(world.server.head)
    try {
      await as(world, device, () => device.poll())
    } finally {
      world.server.hiddenSeqs.clear()
    }
  }

  toString(): string {
    return `pollWithHiddenHead(${deviceName(this.device)})`
  }
}

/** Two devices upload snapshots, the second not yet seeing the first one's newest row */
export class RaceSnapshots implements SyncCommand {
  constructor(readonly first: number, readonly second: number) {}

  check(model: Readonly<Model>): boolean {
    return this.first !== this.second && Math.max(this.first, this.second) < model.deviceCount
  }

  async run(_model: Model, world: World): Promise<void> {
    const first = world.devices[this.first]
    const second = world.devices[this.second]
    await as(world, first, () => first.uploadSnapshots())
    world.server.hiddenSeqs.add(world.server.head)
    try {
      await as(world, second, () => second.uploadSnapshots())
    } finally {
      world.server.hiddenSeqs.clear()
    }
  }

  toString(): string {
    return `raceSnapshots(${deviceName(this.first)}, ${deviceName(this.second)})`
  }
}

/** The jumps the clock makes, each past a timeout the engine waits on */
const CLOCK_JUMPS = [
  SYNC_TIMEOUTS.gapWait,
  SYNC_TIMEOUTS.snapshotDebounce,
  SYNC_TIMEOUTS.snapshotMaxWait,
  SYNC_TIMEOUTS.manifestSyncInterval,
  SYNC_TIMEOUTS.pulledChangesGrace,
]

/** The operations a run picks from, weighted towards the everyday ones */
export function commandArbitrary(deviceCount: number): fc.Arbitrary<SyncCommand> {
  const device = fc.nat({ max: deviceCount - 1 })
  const item = fc.nat({ max: 31 })
  return fc.oneof(
    { weight: 5, arbitrary: device.map(d => new Create(d)) },
    { weight: 12, arbitrary: fc.tuple(device, item).map(([d, i]) => new Edit(d, i)) },
    { weight: 1, arbitrary: fc.tuple(device, item).map(([d, i]) => new Delete(d, i)) },
    { weight: 10, arbitrary: device.map(d => new Poll(d)) },
    { weight: 3, arbitrary: device.map(d => new UploadSnapshots(d)) },
    { weight: 2, arbitrary: device.map(d => new ManifestSync(d)) },
    { weight: 4, arbitrary: device.map(d => new Store(d)) },
    { weight: 1, arbitrary: device.map(d => new SetOnline(d, false)) },
    { weight: 2, arbitrary: device.map(d => new SetOnline(d, true)) },
    { weight: 1, arbitrary: device.map(d => new Restart(d)) },
    {
      weight: 2,
      arbitrary: fc.tuple(
        device,
        fc.constantFrom<InFlight>('none', 'poll', 'upload', 'manifestSync'),
        fc.nat({ max: 20 }),
      ).map(([d, during, ticks]) => new Crash(d, during, ticks)),
    },
    { weight: 2, arbitrary: fc.constantFrom(...CLOCK_JUMPS).map(ms => new AdvanceClock(ms)) },
    { weight: 1, arbitrary: fc.constant(new ExpireLog()) },
    { weight: 1, arbitrary: fc.nat({ max: 63 }).map(row => new LoseRow(row)) },
    { weight: 1, arbitrary: device.map(d => new PollWithHiddenHead(d)) },
    { weight: 1, arbitrary: fc.tuple(device, device).map(([a, b]) => new RaceSnapshots(a, b)) },
  )
}

// ---------------------------------------------------------------------------------------------------
// The world

/** A fresh server and fresh devices on fresh storage, every device online and caught up */
export async function createWorld(deviceCount: number): Promise<{ model: Model; real: World }> {
  installLocalStorage()
  const world: World = {
    server: new FakeVaultServer(),
    keys: await createAccountKeys(),
    devices: [],
    clockOffset: 0,
  }
  vi.spyOn(Date, 'now').mockImplementation(() => now(world))
  world.server.clock = () => now(world)
  for (let i = 0; i < deviceCount; i += 1) {
    world.devices.push(await new Device(deviceName(i), world.server, world.keys).start())
  }
  for (const device of world.devices) {
    await device.poll()
  }
  const model: Model = {
    deviceCount,
    items: [],
    nextItem: 1,
    nextEdit: 1,
    unstored: new Map(),
    durableEdits: new Map(),
    durableCreates: new Set(),
    durableDeletes: new Set(),
  }
  return { model, real: world }
}

export async function destroyWorld(world: World, observers: Device[] = []): Promise<void> {
  world.server.isDown = false
  await Promise.all([...world.devices, ...observers].map(device => (
    device.context?.session.isShutdown === false ? device.stop() : null
  )))
}

/** What the system looks like, in enough detail that two equal fingerprints mean nothing moved */
async function fingerprint(world: World, model: Model): Promise<string> {
  const devices = await Promise.all(world.devices.map(async device => ({
    pending: (await device.pending()).sort(),
    heads: await Promise.all(model.items.map(async id => (await device.heads(id))?.sort() ?? null)),
  })))
  const server = {
    head: world.server.head,
    items: Array.from(world.server.items.entries()).map(([id, item]) => [id, item.version, item.deleted]),
  }
  return JSON.stringify({ devices, server })
}

/** Every device does everything a device online does, until nothing changes */
async function syncRounds(world: World, model: Model, trace: string[]): Promise<void> {
  let previous = ''
  for (let round = 0; round < MAX_QUIESCE_ROUNDS; round += 1) {
    for (const device of world.devices) {
      await device.poll()
      await device.manifestSync()
      await device.uploadSnapshots()
      await device.poll()
    }
    await settle()
    world.clockOffset += HOUR
    const current = await fingerprint(world, model)
    trace.push(`quiesce round ${round + 1}`)
    if (current === previous) return
    previous = current
  }
  throw new Error(`Still changing after ${MAX_QUIESCE_ROUNDS} quiesce rounds`)
}

/**
 * Brings every device back online and lets the system settle: first until it converges, then past
 * `pulledChangesGrace` so that devices holding pulled changes no snapshot confirms upload them (S3).
 */
export async function quiesce(world: World, model: Model): Promise<void> {
  const trace: string[] = []
  world.server.isDown = false
  world.server.hiddenSeqs.clear()
  for (const device of world.devices) {
    device.setOnline(true)
  }
  await syncRounds(world, model, trace)
  world.clockOffset += SYNC_TIMEOUTS.pulledChangesGrace + HOUR
  await syncRounds(world, model, trace)
}

// ---------------------------------------------------------------------------------------------------
// Assertions

interface DeviceView {
  name: string
  live: ItemId[]
  heads: Map<ItemId, string[] | null>
  edits: Map<ItemId, string[]>
  quarantined: ItemId[]
  pending: ItemId[]
}

async function view(device: Device): Promise<DeviceView> {
  const live = (await device.liveIds()).sort()
  const heads = new Map<ItemId, string[] | null>()
  const edits = new Map<ItemId, string[]>()
  for (const id of live) {
    heads.set(id, (await device.heads(id))?.sort() ?? null)
    const doc = await device.read(id)
    edits.set(id, Object.keys(doc ?? {}).filter(key => EDIT_KEY.test(key)).sort())
  }
  return {
    name: device.name,
    live,
    heads,
    edits,
    quarantined: await device.quarantined(),
    pending: await device.pending(),
  }
}

/** A new device that syncs from the server alone, as a fresh install does */
async function startObserver(world: World, name: string): Promise<Device> {
  const observer = await new Device(name, world.server, world.keys).start()
  // A gap the log can't fill must be old enough to count as lost
  world.clockOffset += SYNC_TIMEOUTS.gapWait
  await observer.poll()
  await observer.manifestSync()
  await observer.poll()
  await settle()
  return observer
}

function expectSameAs(reference: DeviceView, other: DeviceView): void {
  const context = `${other.name} against ${reference.name}`
  expect(other.live, `${context}: live items`).toEqual(reference.live)
  for (const id of reference.live) {
    expect(other.heads.get(id), `${context}: heads of ${id}`).toEqual(reference.heads.get(id))
    expect(other.edits.get(id), `${context}: edits in ${id}`).toEqual(reference.edits.get(id))
  }
}

/**
 * Checks, after `quiesce`, that the devices converged and lost nothing they had stored, that a new
 * device gets everything from the server, with and without the log, and that nothing was quarantined.
 * Returns the observers it started, which the caller stops.
 */
export async function assertConverged(world: World, model: Model, observers: Device[]): Promise<void> {
  const views = await Promise.all(world.devices.map(view))
  const [reference] = views

  for (const other of views.slice(1)) expectSameAs(reference, other)

  for (const deviceView of views) {
    expect(deviceView.quarantined, `${deviceView.name}: quarantined`).toEqual([])
    expect(deviceView.pending, `${deviceView.name}: pending`).toEqual([])
  }

  for (const id of model.durableDeletes) {
    expect(reference.live, `deleted ${id} is live`).not.toContain(id)
    expect(world.server.items.get(id)?.deleted, `deleted ${id} on the server`).toBe(true)
  }
  for (const id of model.durableCreates) {
    const isLive = reference.live.includes(id)
    expect(isLive || world.server.items.get(id)?.deleted === true, `stored ${id} is lost`).toBe(true)
  }
  for (const [id, keys] of model.durableEdits) {
    if (!reference.live.includes(id)) continue
    expect(reference.edits.get(id), `stored edits to ${id}`).toEqual(expect.arrayContaining(Array.from(keys)))
  }

  // The server alone holds everything, first with its log, then from snapshots alone
  const withLog = await startObserver(world, 'observer-x')
  observers.push(withLog)
  const withLogView = await view(withLog)
  expectSameAs(reference, withLogView)
  expect(withLogView.quarantined, 'observer with the log: quarantined').toEqual([])

  world.server.expireLog()
  const fromSnapshots = await startObserver(world, 'observer-y')
  observers.push(fromSnapshots)
  const fromSnapshotsView = await view(fromSnapshots)
  expectSameAs(reference, fromSnapshotsView)
  expect(fromSnapshotsView.quarantined, 'observer from snapshots: quarantined').toEqual([])
}

/** Runs the commands on a fresh world, then quiesces and checks it */
export async function runScenario(deviceCount: number, commands: Iterable<SyncCommand>): Promise<void> {
  let world: World | undefined
  let model: Model | undefined
  const observers: Device[] = []
  try {
    // The commands change the model in place, so this one is the model as they left it
    await fc.asyncModelRun(async () => {
      const setup = await createWorld(deviceCount)
      world = setup.real
      model = setup.model
      return setup
    }, commands)
    if (!world || !model) throw new Error('No world was created')
    await quiesce(world, model)
    await assertConverged(world, model, observers)
  } finally {
    if (world) await destroyWorld(world, observers)
  }
}
