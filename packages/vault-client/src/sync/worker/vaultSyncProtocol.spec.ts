import { type DocHandle, type DocumentId, Repo } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'

import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { WorkerInternalEventHub } from './SyncEventHub'

/**
 * End-to-end protocol tests for the simulated `vault` peer, using a real Automerge Repo.
 *
 * The server is modelled as an append-only list of sync messages. Pushes are acknowledged
 * immediately (mirroring `pushAcknowledged` → `setSyncedHeads`), and pulls deliver every
 * message, including the device's own echoes, via `receiveServerMessage`.
 */

type LogDoc = { log: string[] }
type ServerMessage = { documentId: DocumentId; data: Uint8Array }

// The repo syncs asynchronously, so tests poll the fake server rather than sleeping
const POLL = { timeout: 5000, interval: 10 }

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
  readonly adapter: VaultNetworkAdapter
  readonly repo: Repo
  private pulled = 0

  constructor(private readonly server: FakeServer) {
    const eventHub = new WorkerInternalEventHub()
    this.adapter = new VaultNetworkAdapter(eventHub, {
      headsValidator: (documentId, heads) => {
        const handle = this.repo.handles[documentId]
        const doc = handle?.isReady() ? handle.doc() : undefined
        return doc ? Automerge.hasHeads(doc, heads) : false
      },
    })
    this.adapter.setSendEnabled(true)
    this.adapter.setAccount('test-account')
    eventHub.subscribe(event => {
      if (event.type !== 'messageToSend') return
      const { documentId, data } = event.message
      if (!documentId || !(data instanceof Uint8Array)) return
      this.server.messages.push({ documentId, data })
      this.adapter.setSyncedHeads(documentId, decodeSyncMessage(data).heads)
    })
    this.repo = new Repo({ network: [this.adapter] })
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
  reconnect(): void {
    this.adapter.setSendEnabled(false)
    this.adapter.setSendEnabled(true)
  }

  async shutdown(): Promise<void> {
    await this.repo.shutdown()
  }
}

/** Compares what a fresh device would rebuild from the server against the local document. */
function compareWithServer(server: FakeServer, handle: DocHandle<LogDoc>) {
  const rebuilt = server.rebuild(handle.documentId)
  return {
    server: { log: rebuilt.log, missingDeps: Automerge.getMissingDeps(rebuilt, []) },
    local: { log: handle.doc()!.log, missingDeps: [] },
  }
}

/** Waits until a fresh device could rebuild the local document from the server alone. */
async function untilPushed(server: FakeServer, handle: DocHandle<LogDoc>): Promise<void> {
  await vi.waitFor(() => {
    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  }, POLL)
}

/** Pushes each edit on its own, then pulls everything back, echoes included. */
async function editAndPoll(
  device: Device,
  server: FakeServer,
  handle: DocHandle<LogDoc>,
  entries: string[],
): Promise<void> {
  for (const entry of entries) {
    handle.change(doc => { doc.log.push(entry) })
    await untilPushed(server, handle)
  }
  device.pull()
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
    const handle = device.repo.create<LogDoc>({ log: [] })

    for (let round = 0; round < 3; round += 1) {
      await editAndPoll(device, server, handle, [`${round}a`, `${round}b`])
    }

    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('pushes every offline edit after a reload, followed by subsequent edits', async () => {
    const device = createDevice()
    const handle = device.repo.create<LogDoc>({ log: [] })
    await editAndPoll(device, server, handle, ['synced'])

    device.adapter.setSendEnabled(false)
    for (const entry of ['offline-1', 'offline-2', 'offline-3']) {
      handle.change(doc => { doc.log.push(entry) })
    }
    device.reconnect()
    await editAndPoll(device, server, handle, ['online-1', 'online-2'])

    expect(handle.doc()!.log).toHaveLength(6)
    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('pushes the full history when persisted synced heads are unknown to the document', async () => {
    const device = createDevice()
    const handle = device.repo.create<LogDoc>({ log: [] })
    await editAndPoll(device, server, handle, ['a', 'b'])

    const staleHeads = Automerge.getHeads(Automerge.from({ unrelated: true }))
    server.messages.length = 0
    device.skipPendingPulls()
    device.adapter.setSyncedHeads(handle.documentId, staleHeads)
    device.reconnect()
    await editAndPoll(device, server, handle, ['c'])

    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('keeps pushing local edits after receiving a server message with an unknown sync state', async () => {
    const device = createDevice()
    const handle = device.repo.create<LogDoc>({ log: [] })
    await editAndPoll(device, server, handle, ['a'])

    const foreignHeads = Automerge.getHeads(Automerge.from({ unrelated: true }))
    device.adapter.receiveServerMessage(handle.documentId, encodeSyncMessage({
      heads: foreignHeads,
      need: [],
      have: [{ lastSync: foreignHeads, bloom: new Uint8Array() }],
      changes: [],
    }))

    const before = server.messages.length
    await editAndPoll(device, server, handle, ['b'])

    expect(server.messages.length).toBeGreaterThan(before)
    const { server: fromServer, local } = compareWithServer(server, handle)
    expect(fromServer).toEqual(local)
  })

  it('converges two devices editing concurrently through the server', async () => {
    const deviceA = createDevice()
    const deviceB = createDevice()

    const handleA = deviceA.repo.create<LogDoc>({ log: [] })
    await editAndPoll(deviceA, server, handleA, ['a0'])
    deviceB.pull()
    await vi.waitFor(() => {
      expect(deviceB.repo.handles[handleA.documentId]?.isReady()).toBe(true)
    }, POLL)
    const handleB = await deviceB.repo.find<LogDoc>(handleA.url)

    // Keeps pulling until both devices and the server hold the same document
    const syncAll = () => vi.waitFor(() => {
      deviceA.pull()
      deviceB.pull()
      expect(handleB.doc()!.log).toEqual(handleA.doc()!.log)
      const { server: fromServer, local } = compareWithServer(server, handleA)
      expect(fromServer).toEqual(local)
    }, POLL)

    await editAndPoll(deviceA, server, handleA, ['a1', 'a2', 'a3'])
    await syncAll()
    await editAndPoll(deviceB, server, handleB, ['b1', 'b2'])
    await syncAll()
    handleA.change(doc => { doc.log.push('a-concurrent') })
    handleB.change(doc => { doc.log.push('b-concurrent') })
    await syncAll()

    expect(handleA.doc()!.log).toHaveLength(8)
    expect(Automerge.equals(handleA.doc(), handleB.doc())).toBe(true)
    const { server: fromServer, local } = compareWithServer(server, handleA)
    expect(fromServer).toEqual(local)
  })
})
