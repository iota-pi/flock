import { type DocHandle, type DocumentId, Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'

import { VaultNetworkAdapter } from './VaultNetworkAdapter'

/**
 * End-to-end protocol tests for the simulated `vault` peer, using a real Automerge Repo.
 *
 * The server is modelled as an append-only list of sync messages. Pushes are acknowledged
 * immediately (mirroring `pushAcknowledged` → `setSyncedHeads`), and pulls deliver every
 * message, including the device's own echoes, via `receiveServerMessage`.
 */

type LogDoc = { log: string[] }
type ServerMessage = { documentId: DocumentId; data: Uint8Array }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class FakeServer {
  readonly messages: ServerMessage[] = []

  /** Rebuilds a document from scratch using only the messages held by the server. */
  rebuild(documentId: DocumentId): Automerge.Doc<LogDoc> {
    let doc = Automerge.init<LogDoc>()
    let state = Automerge.initSyncState()
    for (const message of this.messages) {
      if (message.documentId !== documentId) continue
      ;[doc, state] = Automerge.receiveSyncMessage(doc, state, message.data)
    }
    return doc
  }
}

class Device {
  readonly adapter = new VaultNetworkAdapter()
  readonly repo: Repo
  private pulled = 0

  constructor(private readonly server: FakeServer) {
    this.adapter.setSendEnabled(true)
    this.adapter.setAccount('test-account')
    this.adapter.eventHub.subscribe(event => {
      if (event.type !== 'messageToSend') return
      const { documentId, data } = event.message
      if (!documentId || !(data instanceof Uint8Array)) return
      this.server.messages.push({ documentId, data })
      this.adapter.setSyncedHeads(documentId, decodeSyncMessage(data).heads)
    })
    this.repo = new Repo({ network: [this.adapter] })
    this.adapter.setHeadsValidator((documentId, heads) => {
      const handle = this.repo.handles[documentId]
      const doc = handle?.isReady() ? handle.doc() : undefined
      return doc ? Automerge.hasHeads(doc, heads) : false
    })
  }

  pull(): void {
    for (; this.pulled < this.server.messages.length; this.pulled += 1) {
      const { documentId, data } = this.server.messages[this.pulled]
      this.adapter.receiveServerMessage(documentId, data)
    }
  }

  skipPendingPulls(): void {
    this.pulled = this.server.messages.length
  }

  /** Simulates a page reload: the vault peer disconnects and renegotiates every document. */
  async reconnect(): Promise<void> {
    this.adapter.setSendEnabled(false)
    await sleep(20)
    this.adapter.setSendEnabled(true)
    await sleep(100)
  }

  async shutdown(): Promise<void> {
    await this.repo.shutdown()
  }
}

async function editAndPoll(device: Device, handle: DocHandle<LogDoc>, entries: string[]): Promise<void> {
  for (const entry of entries) {
    handle.change(doc => { doc.log.push(entry) })
    await sleep(20)
  }
  await sleep(50)
  device.pull()
  await sleep(50)
}

/** Compares what a fresh device would rebuild from the server against the local document. */
function compareWithServer(server: FakeServer, handle: DocHandle<LogDoc>) {
  const rebuilt = server.rebuild(handle.documentId)
  return {
    server: { log: rebuilt.log, missingDeps: Automerge.getMissingDeps(rebuilt, []) },
    local: { log: handle.doc()!.log, missingDeps: [] },
  }
}

describe('vault sync protocol', () => {
  let devices: Device[] = []
  let server: FakeServer

  beforeEach(() => {
    server = new FakeServer()
    devices = []
  })

  afterEach(async () => {
    await Promise.all(devices.map(device => device.shutdown()))
  })

  function createDevice(): Device {
    const device = new Device(server)
    devices.push(device)
    return device
  }

  it('pushes every change for a new document edited repeatedly', async () => {
    const device = createDevice()
    await sleep(50)
    const handle = device.repo.create<LogDoc>({ log: [] })
    await sleep(100)

    for (let round = 0; round < 3; round += 1) {
      await editAndPoll(device, handle, [`${round}a`, `${round}b`])
    }

    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('pushes every offline edit after a reload, followed by subsequent edits', async () => {
    const device = createDevice()
    await sleep(50)
    const handle = device.repo.create<LogDoc>({ log: [] })
    await editAndPoll(device, handle, ['synced'])

    device.adapter.setSendEnabled(false)
    for (const entry of ['offline-1', 'offline-2', 'offline-3']) {
      handle.change(doc => { doc.log.push(entry) })
    }
    await device.reconnect()
    await editAndPoll(device, handle, ['online-1', 'online-2'])

    expect(handle.doc()!.log).toHaveLength(6)
    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('pushes the full history when persisted synced heads are unknown to the document', async () => {
    const device = createDevice()
    await sleep(50)
    const handle = device.repo.create<LogDoc>({ log: [] })
    await editAndPoll(device, handle, ['a', 'b'])

    const staleHeads = Automerge.getHeads(Automerge.from({ unrelated: true }))
    server.messages.length = 0
    device.skipPendingPulls()
    device.adapter.setSyncedHeads(handle.documentId, staleHeads)
    await device.reconnect()
    await editAndPoll(device, handle, ['c'])

    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('keeps pushing local edits after receiving a server message with an unknown sync state', async () => {
    const device = createDevice()
    await sleep(50)
    const handle = device.repo.create<LogDoc>({ log: [] })
    await editAndPoll(device, handle, ['a'])

    const foreignHeads = Automerge.getHeads(Automerge.from({ unrelated: true }))
    device.adapter.receiveServerMessage(handle.documentId, encodeSyncMessage({
      heads: foreignHeads,
      need: [],
      have: [{ lastSync: foreignHeads, bloom: new Uint8Array() }],
      changes: [],
    }))
    await sleep(50)

    const before = server.messages.length
    await editAndPoll(device, handle, ['b'])

    expect(server.messages.length).toBeGreaterThan(before)
    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('converges two devices editing concurrently through the server', async () => {
    const deviceA = createDevice()
    const deviceB = createDevice()
    await sleep(50)

    const handleA = deviceA.repo.create<LogDoc>({ log: [] })
    await editAndPoll(deviceA, handleA, ['a0'])
    deviceB.pull()
    await sleep(100)
    const handleB = await deviceB.repo.find<LogDoc>(handleA.url)
    await sleep(50)

    const syncAll = async () => {
      await sleep(50)
      deviceA.pull()
      deviceB.pull()
      await sleep(100)
    }

    await editAndPoll(deviceA, handleA, ['a1', 'a2', 'a3'])
    await syncAll()
    await editAndPoll(deviceB, handleB, ['b1', 'b2'])
    await syncAll()
    handleA.change(doc => { doc.log.push('a-concurrent') })
    handleB.change(doc => { doc.log.push('b-concurrent') })
    await syncAll()
    await syncAll()

    expect(handleA.doc()!.log).toHaveLength(8)
    expect(Automerge.equals(handleA.doc(), handleB.doc())).toBe(true)
    const { server: fromServer, local } = compareWithServer(server, handleA)
    expect(fromServer).toEqual(local)
  })
})
