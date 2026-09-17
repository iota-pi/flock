import { toDocumentIdFromItemId } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'
import type { Item } from 'src/state/items'
import { ItemOperations } from './ItemOperations'
import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import type { Message, PeerId } from '@automerge/automerge-repo/slim'

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('../client/realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: any[]) => mockPublishRealtimeBusSyncPing(...args),
  subscribeRealtimeBusSyncPing: vi.fn(),
}))

vi.mock('@automerge/automerge-repo-network-broadcastchannel', () => {
  const mockOn = vi.fn()
  const mockSend = vi.fn()
  const mockConnect = vi.fn()
  const mockDisconnect = vi.fn()
  const mockIsReady = vi.fn().mockReturnValue(true)
  const mockWhenReady = vi.fn().mockResolvedValue(undefined)

  class BroadcastChannelNetworkAdapterMock {
    on = mockOn
    send = mockSend
    connect = mockConnect
    disconnect = mockDisconnect
    isReady = mockIsReady
    whenReady = mockWhenReady
  }

  return {
    BroadcastChannelNetworkAdapter: BroadcastChannelNetworkAdapterMock,
  }
})

vi.mock('src/api/vault', () => ({
  encryptBytes: vi.fn().mockImplementation(async (bytes: Uint8Array) => ({
    iv: 'mock-iv',
    cipher: 'mock-cipher-' + Array.from(bytes).join(','),
    kver: '1',
    version: '1.0',
  })),
  decryptBytes: vi.fn().mockImplementation(async (payload: any) => {
    const suffix = payload.cipher.replace('mock-cipher-', '')
    if (suffix === '') return new Uint8Array([])
    return new Uint8Array(suffix.split(',').map((x: string) => parseInt(x, 10)))
  }),
  hasVaultKey: vi.fn().mockReturnValue(true),
  waitForKeyVersion: vi.fn().mockResolvedValue(true),
}))

describe('Cross-Tab New Item Discovery Offline (C7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishRealtimeBusSyncPing.mockClear()
  })

  it('Tab 1 creates item offline: publishes realtimeBus sync ping and indexes item', async () => {
    const changeDocumentMock = vi.fn().mockResolvedValue(true)
    const addAutomergeItemIdsToIndexMock = vi.fn().mockResolvedValue(undefined)
    const markDocumentDirtyMock = vi.fn()
    const emitMock = vi.fn()

    const itemOps = new ItemOperations({
      accountId: 'account-1',
      docStore: {
        changeDocument: changeDocumentMock,
        getAutomergeItem: vi.fn(),
        removeAutomergeItem: vi.fn(),
      } as any,
      indexManager: {
        addAutomergeItemIdsToIndex: addAutomergeItemIdsToIndexMock,
        listAutomergeItemIds: vi.fn().mockResolvedValue([]),
        removeAutomergeItemIdsFromIndex: vi.fn(),
        updateAutomergeMetadata: vi.fn(),
        getAutomergeMetadata: vi.fn(),
      } as any,
      eventHub: { emit: emitMock } as any,
      markDocumentDirty: markDocumentDirtyMock,
    })

    const newItem: Item = {
      id: 'offline-item-123' as ItemId,
      type: 'person',
      name: 'Offline Prayer',
      description: 'Created while offline in Tab 1',
      created: Date.now(),
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    await itemOps.createItem(newItem)

    expect(changeDocumentMock).toHaveBeenCalledWith(
      'offline-item-123',
      expect.any(Function),
      { createIfMissing: true, knownToExist: false },
    )
    expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['offline-item-123'])
    expect(markDocumentDirtyMock).toHaveBeenCalledWith('offline-item-123')
    expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith(['offline-item-123'])
  })

  it('Tab 1 transmits sync message: EncryptedBroadcastChannelNetworkAdapter notifies peer tabs via realtimeBus', async () => {
    const adapter = new EncryptedBroadcastChannelNetworkAdapter()
    const docId = toDocumentIdFromItemId('offline-item-456' as ItemId)

    const syncMessage: Message = {
      type: 'sync',
      senderId: 'tab1' as PeerId,
      targetId: 'tab2' as PeerId,
      documentId: docId,
      data: new Uint8Array([1, 2, 3]),
    }

    adapter.send(syncMessage)

    await vi.waitFor(() => {
      expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith(['offline-item-456'])
    })
  })

  it('Tab 2 receives sync message: EncryptedBroadcastChannelNetworkAdapter invokes onDocumentReceived callback', async () => {
    const onDocumentReceivedMock = vi.fn()
    const adapter = new EncryptedBroadcastChannelNetworkAdapter({
      onDocumentReceived: onDocumentReceivedMock,
    })

    const innerMock = (adapter as any).inner
    let innerMessageCallback: any
    for (const call of innerMock.on.mock.calls) {
      if (call[0] === 'message') innerMessageCallback = call[1]
    }

    const docId = toDocumentIdFromItemId('offline-item-789' as ItemId)
    const cryptoResult = {
      iv: 'iv',
      cipher: 'mock-cipher-4,5',
      kver: '1',
      version: '1.0',
    }
    const encryptedData = new TextEncoder().encode(JSON.stringify(cryptoResult))

    innerMessageCallback({
      type: 'sync',
      senderId: 'tab1' as PeerId,
      targetId: 'tab2' as PeerId,
      documentId: docId,
      data: encryptedData,
    })

    await vi.waitFor(() => {
      expect(onDocumentReceivedMock).toHaveBeenCalledWith(docId)
    })
  })
})
