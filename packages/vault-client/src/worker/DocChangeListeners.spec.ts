import {
  NetworkAdapter,
  Repo,
  type DocHandle,
  type DocumentId,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '@vault/shared'
import { DocChangeListeners } from './DocChangeListeners'
import { ACCOUNT_INDEX_DOCUMENT_ID, toDocumentIdFromItemId } from './utils/automerge'

type TestDoc = { title?: string }

const ITEM = 'item-1' as ItemId

/**
 * One end of an in-memory link between Repos. Like the broadcast adapter, it reports each message's
 * doc to `onReceived` after dispatching the message.
 */
class LinkedAdapter extends NetworkAdapter {
  other: LinkedAdapter | null = null
  onReceived: ((documentId: DocumentId) => void) | null = null

  isReady(): boolean {
    return true
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
  }

  send(message: Message): void {
    const target = this.other
    if (!target) return
    void Promise.resolve().then(() => {
      target.emit('message', message)
      if (message.documentId) target.onReceived?.(message.documentId)
    })
  }

  disconnect(): void {
    this.other = null
  }

  /** Tells this adapter's Repo about the peer at the other end */
  meet(other: LinkedAdapter): void {
    this.other = other
    if (!other.peerId) throw new Error('The other adapter is not connected')
    this.emit('peer-candidate', { peerId: other.peerId, peerMetadata: other.peerMetadata ?? {} })
  }
}

function importDoc(repo: Repo, id: string, doc: TestDoc = { title: 'start' }): DocHandle<TestDoc> {
  const binary = Automerge.save(Automerge.from<TestDoc>(doc))
  return repo.import<TestDoc>(binary, { docId: toDocumentIdFromItemId(id as ItemId) })
}

describe('DocChangeListeners', () => {
  let repo: Repo
  let onDocChanged: ReturnType<typeof vi.fn<(itemId: ItemId) => void>>
  let listeners: DocChangeListeners

  beforeEach(() => {
    repo = new Repo()
    onDocChanged = vi.fn<(itemId: ItemId) => void>()
    listeners = new DocChangeListeners(repo, onDocChanged)
  })

  afterEach(async () => {
    listeners.clear()
    await repo.shutdown()
  })

  it('adds one listener per handle and reports its changes with the item ID', () => {
    const handle = importDoc(repo, ITEM)
    const on = vi.spyOn(handle, 'on')

    expect(listeners.watchHandle(handle)).toBeTypeOf('function')
    expect(listeners.watchHandle(handle)).toBeUndefined()
    handle.change(doc => {
      doc.title = 'edited'
    })

    expect(on.mock.calls.filter(([event]) => event === 'change')).toHaveLength(1)
    expect(onDocChanged).toHaveBeenCalledTimes(1)
    expect(onDocChanged).toHaveBeenCalledWith(ITEM)
  })

  it('skips the index document', () => {
    const handle = importDoc(repo, ACCOUNT_INDEX_DOCUMENT_ID)
    const on = vi.spyOn(handle, 'on')

    expect(listeners.watchHandle(handle)).toBeUndefined()
    handle.change(doc => {
      doc.title = 'edited'
    })

    expect(on).not.toHaveBeenCalled()
    expect(onDocChanged).not.toHaveBeenCalled()
  })

  it('moves the listener to a handle that takes the item\'s place, removing the old one by reference', async () => {
    const otherRepo = new Repo()
    const oldHandle = importDoc(otherRepo, ITEM)
    const newHandle = importDoc(repo, ITEM)
    const on = vi.spyOn(oldHandle, 'on')
    const off = vi.spyOn(oldHandle, 'off')

    listeners.watchHandle(oldHandle)
    listeners.watchHandle(newHandle)

    const added = on.mock.calls.find(([event]) => event === 'change')?.[1]
    expect(added).toBeTypeOf('function')
    expect(off).toHaveBeenCalledWith('change', added)

    oldHandle.change(doc => {
      doc.title = 'old'
    })
    expect(onDocChanged).not.toHaveBeenCalled()
    newHandle.change(doc => {
      doc.title = 'new'
    })
    expect(onDocChanged).toHaveBeenCalledWith(ITEM)
    await otherRepo.shutdown()
  })

  it('removes the listener when the Repo deletes the doc', () => {
    const handle = importDoc(repo, ITEM)
    const on = vi.spyOn(handle, 'on')
    const off = vi.spyOn(handle, 'off')
    listeners.watchHandle(handle)

    repo.delete(handle.documentId)

    const added = on.mock.calls.find(([event]) => event === 'change')?.[1]
    expect(off).toHaveBeenCalledWith('change', added)
  })

  it('removes every listener on clear with the reference it added, and adds none after', () => {
    const handle = importDoc(repo, ITEM)
    const on = vi.spyOn(handle, 'on')
    const off = vi.spyOn(handle, 'off')
    const repoOff = vi.spyOn(repo, 'off')
    listeners.watchHandle(handle)

    listeners.clear()

    const added = on.mock.calls.find(([event]) => event === 'change')?.[1]
    expect(off).toHaveBeenCalledWith('change', added)
    expect(repoOff).toHaveBeenCalledWith('delete-document', expect.any(Function))
    expect(listeners.watchHandle(handle)).toBeUndefined()
    handle.change(doc => {
      doc.title = 'edited'
    })
    expect(onDocChanged).not.toHaveBeenCalled()
  })

  it('listens to the handle the Repo creates for a doc another tab sends it', async () => {
    const senderAdapter = new LinkedAdapter()
    const receiverAdapter = new LinkedAdapter()
    const senderRepo = new Repo({ network: [senderAdapter] })
    const receiverRepo = new Repo({ network: [receiverAdapter] })
    const receiverListeners = new DocChangeListeners(receiverRepo, onDocChanged)
    receiverAdapter.onReceived = documentId => receiverListeners.watchReceivedDocument(documentId)
    await vi.waitFor(() => {
      expect(senderAdapter.peerId && receiverAdapter.peerId).toBeTruthy()
    })
    senderAdapter.meet(receiverAdapter)
    receiverAdapter.meet(senderAdapter)

    const sent = importDoc(senderRepo, ITEM)
    const documentId = toDocumentIdFromItemId(ITEM)
    expect(receiverRepo.handles[documentId]).toBeUndefined()

    await vi.waitFor(() => {
      expect(receiverRepo.handles[documentId]?.isReady()).toBe(true)
      expect(onDocChanged).toHaveBeenCalledWith(ITEM)
    })

    onDocChanged.mockClear()
    sent.change(doc => {
      doc.title = 'edited in the other tab'
    })
    await vi.waitFor(() => {
      expect(receiverRepo.handles[documentId]?.doc()).toEqual({ title: 'edited in the other tab' })
    })
    expect(onDocChanged).toHaveBeenCalledWith(ITEM)

    receiverListeners.clear()
    await Promise.all([senderRepo.shutdown(), receiverRepo.shutdown()])
  })
})
