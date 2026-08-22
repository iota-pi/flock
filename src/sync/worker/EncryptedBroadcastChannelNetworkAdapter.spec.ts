import type { DocumentId, Message, PeerId } from '@automerge/automerge-repo/slim'

import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'


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
  encryptBytes: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
    return {
      iv: 'mock-iv',
      cipher: 'mock-cipher-' + Array.from(bytes).join(','),
      kver: '1',
      version: '1.0',
    }
  }),
  decryptBytes: vi.fn().mockImplementation(async (payload: any) => {
    // extract digits from cipher to mock decryption
    const suffix = payload.cipher.replace('mock-cipher-', '')
    if (suffix === '') return new Uint8Array([])
    return new Uint8Array(suffix.split(',').map((x: string) => parseInt(x, 10)))
  }),
}))

describe('EncryptedBroadcastChannelNetworkAdapter', () => {
  let adapter: EncryptedBroadcastChannelNetworkAdapter
  let innerAdapterMock: any

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new EncryptedBroadcastChannelNetworkAdapter()
    innerAdapterMock = (adapter as any).inner
  })

  it('connects and disconnects the inner adapter', () => {
    const peerId = 'peer1' as PeerId
    const peerMetadata = { isEphemeral: true }

    adapter.connect(peerId, peerMetadata)
    expect(innerAdapterMock.connect).toHaveBeenCalledWith(peerId, peerMetadata)
    expect(adapter.peerId).toBe(peerId)
    expect(adapter.peerMetadata).toBe(peerMetadata)

    adapter.disconnect()
    expect(innerAdapterMock.disconnect).toHaveBeenCalled()
  })

  it('delegates isReady and whenReady to the inner adapter', async () => {
    expect(adapter.isReady()).toBe(true)
    await expect(adapter.whenReady()).resolves.toBeUndefined()
  })

  it('encrypts and sends messages with data, maintaining queue order', async () => {
    const message1: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'doc1' as DocumentId,
      data: new Uint8Array([1, 2, 3]),
    }

    const message2: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'doc2' as DocumentId,
      data: new Uint8Array([4, 5]),
    }

    // Call send twice consecutively to test queuing & ordering
    adapter.send(message1)
    adapter.send(message2)

    // Wait for the async processQueue to process both
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(innerAdapterMock.send).toHaveBeenCalledTimes(2)

    const firstSent = innerAdapterMock.send.mock.calls[0][0]
    expect(firstSent.type).toBe('sync')
    expect(firstSent.documentId).toBe('doc1')

    const decodedFirstData = JSON.parse(new TextDecoder().decode(firstSent.data))
    expect(decodedFirstData).toEqual({
      iv: 'mock-iv',
      cipher: 'mock-cipher-1,2,3',
      kver: '1',
      version: '1.0',
    })

    const secondSent = innerAdapterMock.send.mock.calls[1][0]
    expect(secondSent.type).toBe('sync')
    expect(secondSent.documentId).toBe('doc2')

    const decodedSecondData = JSON.parse(new TextDecoder().decode(secondSent.data))
    expect(decodedSecondData).toEqual({
      iv: 'mock-iv',
      cipher: 'mock-cipher-4,5',
      kver: '1',
      version: '1.0',
    })
  })

  it('decrypts incoming messages with data and emits them', async () => {
    const mockMessageListener = vi.fn()
    adapter.on('message', mockMessageListener)

    // Locate the listener registered on the inner adapter
    const innerOnCalls = innerAdapterMock.on.mock.calls
    const messageCall = innerOnCalls.find((call: any) => call[0] === 'message')
    expect(messageCall).toBeDefined()
    const innerMessageCallback = messageCall[1]

    // Construct an encrypted message payload as if received by BroadcastChannel
    const cryptoResult = {
      iv: 'mock-iv',
      cipher: 'mock-cipher-9,9,9',
      kver: '1',
      version: '1.0',
    }
    const encryptedData = new TextEncoder().encode(JSON.stringify(cryptoResult))
    const incomingMessage: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'doc1' as DocumentId,
      data: encryptedData,
    }

    // Trigger the callback
    innerMessageCallback(incomingMessage)

    // Wait for decryption
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(mockMessageListener).toHaveBeenCalledTimes(1)
    const emittedMessage = mockMessageListener.mock.calls[0][0]
    expect(emittedMessage.type).toBe('sync')
    expect(emittedMessage.documentId).toBe('doc1')
    expect(Array.from(emittedMessage.data)).toEqual([9, 9, 9])
  })

  it('forwards messages without data unchanged', async () => {
    const mockMessageListener = vi.fn()
    adapter.on('message', mockMessageListener)

    const innerOnCalls = innerAdapterMock.on.mock.calls
    const messageCall = innerOnCalls.find((call: any) => call[0] === 'message')
    const innerMessageCallback = messageCall[1]

    const incomingMessage: Message = {
      type: 'request',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'doc1' as DocumentId,
    }

    innerMessageCallback(incomingMessage)

    // Wait just in case
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(mockMessageListener).toHaveBeenCalledTimes(1)
    const emittedMessage = mockMessageListener.mock.calls[0][0]
    expect(emittedMessage).toEqual(incomingMessage)
  })

  it('resets connection and clears queue when encryption throws an error', async () => {
    const { encryptBytes } = await import('src/api/vault')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.mocked(encryptBytes).mockRejectedValueOnce(new Error('Encryption failed'))

    const badMessage: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'badDoc' as DocumentId,
      data: new Uint8Array([9, 9]),
    }

    const goodMessage: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'goodDoc' as DocumentId,
      data: new Uint8Array([1, 2]),
    }

    adapter.send(badMessage)
    adapter.send(goodMessage)

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[EncryptedBroadcastChannel] Error sending message:',
      expect.any(Error)
    )
    expect(innerAdapterMock.disconnect).toHaveBeenCalled()
    expect(innerAdapterMock.send).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })

  it('decrypts incoming messages maintaining queue order even if decryption durations vary', async () => {
    const { decryptBytes } = await import('src/api/vault')
    const mockMessageListener = vi.fn()
    adapter.on('message', mockMessageListener)

    const innerOnCalls = innerAdapterMock.on.mock.calls
    const messageCall = innerOnCalls.find((call: any) => call[0] === 'message')
    const innerMessageCallback = messageCall[1]

    // Custom decryptBytes implementation where message 1 takes longer than message 2
    vi.mocked(decryptBytes).mockImplementation(async (payload: any) => {
      const suffix = payload.cipher.replace('mock-cipher-', '')
      if (suffix === 'first') {
        await new Promise(resolve => setTimeout(resolve, 30))
        return new Uint8Array([1, 1, 1])
      } else {
        await new Promise(resolve => setTimeout(resolve, 5))
        return new Uint8Array([2, 2, 2])
      }
    })

    const payload1 = { iv: 'iv1', cipher: 'mock-cipher-first', kver: '1', version: '1.0' }
    const payload2 = { iv: 'iv2', cipher: 'mock-cipher-second', kver: '1', version: '1.0' }

    const message1: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'doc1' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify(payload1)),
    }

    const message2: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'doc2' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify(payload2)),
    }

    innerMessageCallback(message1)
    innerMessageCallback(message2)

    await new Promise(resolve => setTimeout(resolve, 60))

    expect(mockMessageListener).toHaveBeenCalledTimes(2)
    expect(mockMessageListener.mock.calls[0][0].documentId).toBe('doc1')
    expect(Array.from(mockMessageListener.mock.calls[0][0].data)).toEqual([1, 1, 1])
    expect(mockMessageListener.mock.calls[1][0].documentId).toBe('doc2')
    expect(Array.from(mockMessageListener.mock.calls[1][0].data)).toEqual([2, 2, 2])
  })

  it('resets connection and clears queue when decryption throws an error', async () => {
    const { decryptBytes } = await import('src/api/vault')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockMessageListener = vi.fn()
    adapter.on('message', mockMessageListener)

    const innerOnCalls = innerAdapterMock.on.mock.calls
    const messageCall = innerOnCalls.find((call: any) => call[0] === 'message')
    const innerMessageCallback = messageCall[1]

    vi.mocked(decryptBytes).mockRejectedValueOnce(new Error('Decryption failed'))

    const badPayload = { iv: 'iv1', cipher: 'mock-cipher-bad', kver: '1', version: '1.0' }
    const goodPayload = { iv: 'iv2', cipher: 'mock-cipher-good', kver: '1', version: '1.0' }

    const badMessage: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'badDoc' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify(badPayload)),
    }

    const goodMessage: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'goodDoc' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify(goodPayload)),
    }

    innerMessageCallback(badMessage)
    innerMessageCallback(goodMessage)

    await new Promise(resolve => setTimeout(resolve, 30))

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[EncryptedBroadcastChannel] Error decrypting message:',
      expect.any(Error)
    )
    expect(innerAdapterMock.disconnect).toHaveBeenCalled()
    expect(mockMessageListener).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
    consoleWarnSpy.mockRestore()
  })
})
