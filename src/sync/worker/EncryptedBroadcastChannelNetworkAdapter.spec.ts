import type { DocumentId, Message, PeerId } from '@automerge/automerge-repo/slim'

import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import { toDocumentIdFromItemId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('./realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: any[]) => mockPublishRealtimeBusSyncPing(...args),
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
  hasVaultKey: vi.fn().mockReturnValue(true),
  waitForKeyVersion: vi.fn().mockResolvedValue(true),
}))

describe('EncryptedBroadcastChannelNetworkAdapter', () => {
  let adapter: EncryptedBroadcastChannelNetworkAdapter
  let innerAdapterMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    const { encryptBytes, decryptBytes, hasVaultKey, waitForKeyVersion } = await import('src/api/vault')
    vi.mocked(encryptBytes).mockImplementation(async (bytes: Uint8Array) => {
      return {
        iv: 'mock-iv',
        cipher: 'mock-cipher-' + Array.from(bytes).join(','),
        kver: '1',
        version: '1.0',
      }
    })
    vi.mocked(decryptBytes).mockImplementation(async (payload: any) => {
      const suffix = payload.cipher.replace('mock-cipher-', '')
      if (suffix === '') return new Uint8Array([])
      return new Uint8Array(suffix.split(',').map((x: string) => parseInt(x, 10)))
    })
    vi.mocked(hasVaultKey).mockReturnValue(true)
    vi.mocked(waitForKeyVersion).mockResolvedValue(true)
    adapter = new EncryptedBroadcastChannelNetworkAdapter({ accountId: 'account-1' })
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

  it('continues processing send queue and does not reset connection when encryption throws permanent errors', async () => {
    const { encryptBytes } = await import('src/api/vault')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.mocked(encryptBytes).mockImplementation(async (bytes: Uint8Array) => {
      if (bytes[0] === 9) {
        throw new Error('Encryption failed')
      }
      return {
        iv: 'mock-iv',
        cipher: 'mock-cipher-' + Array.from(bytes).join(','),
        kver: '1',
        version: '1.0',
      }
    })

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

    await vi.waitFor(() => {
      expect(innerAdapterMock.send).toHaveBeenCalledTimes(1)
    })

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[EncryptedBroadcastChannel] Error sending message:',
      expect.any(Error)
    )
    expect(innerAdapterMock.disconnect).not.toHaveBeenCalled()
    expect(innerAdapterMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'goodDoc' })
    )

    consoleErrorSpy.mockRestore()
  })

  it('retries sending a message on transient encryption error and delivers without dropping', async () => {
    const { encryptBytes } = await import('src/api/vault')
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.mocked(encryptBytes).mockRejectedValueOnce(new Error('Transient encryption error'))

    const message: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'retryDoc' as DocumentId,
      data: new Uint8Array([7, 7]),
    }

    adapter.send(message)

    await vi.waitFor(() => {
      expect(innerAdapterMock.send).toHaveBeenCalledTimes(1)
    })

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error sending message (attempt 1/3), retrying:'),
      expect.any(Error)
    )
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(innerAdapterMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'retryDoc' })
    )

    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
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

    await vi.waitFor(() => {
      expect(mockMessageListener).toHaveBeenCalledTimes(2)
    }, { timeout: 1000 })
    expect(mockMessageListener.mock.calls[0][0].documentId).toBe('doc1')
    expect(Array.from(mockMessageListener.mock.calls[0][0].data)).toEqual([1, 1, 1])
    expect(mockMessageListener.mock.calls[1][0].documentId).toBe('doc2')
    expect(Array.from(mockMessageListener.mock.calls[1][0].data)).toEqual([2, 2, 2])
  })

  it('continues processing receive queue and notifies onKeyVersionMissing without resetting connection when decryption throws permanent errors', async () => {
    const onKeyVersionMissing = vi.fn()
    const customAdapter = new EncryptedBroadcastChannelNetworkAdapter({ onKeyVersionMissing })
    const customInnerMock = (customAdapter as any).inner
    const { decryptBytes } = await import('src/api/vault')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockMessageListener = vi.fn()
    customAdapter.on('message', mockMessageListener)

    let innerMessageCallback: any
    for (const call of customInnerMock.on.mock.calls) {
      if (call[0] === 'message') innerMessageCallback = call[1]
    }

    vi.mocked(decryptBytes).mockImplementation(async (payload: any) => {
      if (payload.cipher === 'mock-cipher-bad') {
        throw new Error('Decryption failed')
      }
      return new Uint8Array([1, 2])
    })

    const badPayload = { iv: 'iv1', cipher: 'mock-cipher-bad', kver: '2', version: '1.0' }
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

    await vi.waitFor(() => {
      expect(mockMessageListener).toHaveBeenCalledTimes(1)
    })

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[EncryptedBroadcastChannel] Error decrypting message:',
      expect.any(Error)
    )
    expect(onKeyVersionMissing).toHaveBeenCalledWith('2')
    expect(customInnerMock.disconnect).not.toHaveBeenCalled()
    expect(mockMessageListener).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'goodDoc' })
    )

    consoleErrorSpy.mockRestore()
  })

  it('retries decrypting an incoming message on transient decryption error and emits without dropping', async () => {
    const onKeyVersionMissing = vi.fn()
    const customAdapter = new EncryptedBroadcastChannelNetworkAdapter({ onKeyVersionMissing })
    const customInnerMock = (customAdapter as any).inner
    const { decryptBytes } = await import('src/api/vault')
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockMessageListener = vi.fn()
    customAdapter.on('message', mockMessageListener)

    let innerMessageCallback: any
    for (const call of customInnerMock.on.mock.calls) {
      if (call[0] === 'message') innerMessageCallback = call[1]
    }

    vi.mocked(decryptBytes).mockRejectedValueOnce(new Error('Transient decryption failure'))

    const payload = { iv: 'iv1', cipher: 'mock-cipher-5,6', kver: '1', version: '1.0' }
    const message: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'docRetry' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify(payload)),
    }

    innerMessageCallback(message)

    await vi.waitFor(() => {
      expect(mockMessageListener).toHaveBeenCalledTimes(1)
    })

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error decrypting message (attempt 1/3), retrying:'),
      expect.any(Error)
    )
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(mockMessageListener).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'docRetry', data: new Uint8Array([5, 6]) })
    )

    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('does not disconnect on multiple consecutive crypto errors and continues sending valid messages', async () => {
    const { encryptBytes } = await import('src/api/vault')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.mocked(encryptBytes).mockImplementation(async (bytes: Uint8Array) => {
      if (bytes[0] === 91 || bytes[0] === 92) {
        throw new Error('Encryption failed')
      }
      return {
        iv: 'mock-iv',
        cipher: 'mock-cipher-' + Array.from(bytes).join(','),
        kver: '1',
        version: '1.0',
      }
    })

    const badMessage1: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'badDoc1' as DocumentId,
      data: new Uint8Array([91]),
    }

    const badMessage2: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'badDoc2' as DocumentId,
      data: new Uint8Array([92]),
    }

    const goodMessage: Message = {
      type: 'sync',
      senderId: 'peer1' as PeerId,
      targetId: 'peer2' as PeerId,
      documentId: 'goodDoc' as DocumentId,
      data: new Uint8Array([3]),
    }

    adapter.send(badMessage1)
    adapter.send(badMessage2)
    adapter.send(goodMessage)

    await vi.waitFor(() => {
      expect(innerAdapterMock.send).toHaveBeenCalledTimes(1)
    })

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2)
    expect(innerAdapterMock.disconnect).not.toHaveBeenCalled()
    expect(innerAdapterMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'goodDoc' })
    )

    consoleErrorSpy.mockRestore()
  })

  it('preserves pendingKeyMessages and activeKeyWaiters when a decryption error occurs on another message', async () => {
    const onKeyVersionMissing = vi.fn()
    const customAdapter = new EncryptedBroadcastChannelNetworkAdapter({
      onKeyVersionMissing,
      keyWaitTimeoutMs: 50,
    })
    const customInnerMock = (customAdapter as any).inner
    const mockMessageListener = vi.fn()
    customAdapter.on('message', mockMessageListener)

    let innerCallback: any
    for (const call of customInnerMock.on.mock.calls) {
      if (call[0] === 'message') innerCallback = call[1]
    }

    const { hasVaultKey, waitForKeyVersion, decryptBytes } = await import('src/api/vault')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // kver: '99' is missing initially
    let key99Available = false
    vi.mocked(hasVaultKey).mockImplementation((kver?: string) => {
      if (kver === '99') return key99Available
      return true
    })

    const keyWaitResolvers: Array<(val: boolean) => void> = []
    vi.mocked(waitForKeyVersion).mockImplementation((kver: string) => {
      if (kver === '99' && !key99Available) {
        return new Promise(resolve => {
          keyWaitResolvers.push(resolve)
        })
      }
      return Promise.resolve(true)
    })

    // Msg1 has missing key 99
    const msgPendingKey: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'docPending' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify({ iv: 'iv-pk', cipher: 'mock-cipher-8,8', kver: '99', version: '1.0' })),
    }

    // Msg2 will fail decryption
    const msgBad: Message = {
      type: 'sync',
      senderId: 'peer2' as PeerId,
      targetId: 'peer1' as PeerId,
      documentId: 'docBad' as DocumentId,
      data: new TextEncoder().encode(JSON.stringify({ iv: 'iv-bad', cipher: 'mock-cipher-bad', kver: '1', version: '1.0' })),
    }

    innerCallback(msgPendingKey)
    await vi.waitFor(() => {
      expect(keyWaitResolvers.length).toBeGreaterThan(0)
    })

    // Timeout key 99 waiter so msgPendingKey enters pendingKeyMessages
    const initialResolver = keyWaitResolvers.shift()
    initialResolver?.(false)

    // Now send msgBad which throws during decryptBytes
    vi.mocked(decryptBytes).mockImplementation(async (payload: any) => {
      if (payload.cipher === 'mock-cipher-bad') {
        throw new Error('Corrupt ciphertext')
      }
      return new Uint8Array([8, 8])
    })
    innerCallback(msgBad)

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[EncryptedBroadcastChannel] Error decrypting message:',
        expect.any(Error)
      )
    })

    // Now key 99 becomes available
    key99Available = true
    for (const res of keyWaitResolvers) {
      res(true)
    }

    // msgPendingKey must NOT have been dropped and must decrypt successfully
    await vi.waitFor(() => {
      expect(mockMessageListener).toHaveBeenCalledTimes(1)
    })
    expect(mockMessageListener).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'docPending' })
    )

    consoleErrorSpy.mockRestore()
  })

  describe('Key rotation and missing key buffering', () => {
    it('buffers message, calls onKeyVersionMissing, waits for key, and decrypts once key arrives', async () => {
      const onKeyVersionMissing = vi.fn()
      const adapterWithMissingKey = new EncryptedBroadcastChannelNetworkAdapter({
        channelName: 'test-channel',
        onKeyVersionMissing,
        keyWaitTimeoutMs: 1000,
      })
      const innerMock = (adapterWithMissingKey as any).inner
      const messageListener = vi.fn()
      adapterWithMissingKey.on('message', messageListener)

      let innerCallback: any
      for (const call of innerMock.on.mock.calls) {
        if (call[0] === 'message') innerCallback = call[1]
      }

      const { hasVaultKey, waitForKeyVersion } = await import('src/api/vault')
      // kver: '2' is initially missing
      vi.mocked(hasVaultKey).mockImplementation((kver?: string) => kver !== '2')

      let resolveKeyWait!: (val: boolean) => void
      vi.mocked(waitForKeyVersion).mockImplementationOnce(() => {
        return new Promise(resolve => {
          resolveKeyWait = resolve
        })
      })

      const payload = { iv: 'iv-k2', cipher: 'mock-cipher-7,8,9', kver: '2', version: '1.0' }
      const msg: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'docK2' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(payload)),
      }

      innerCallback(msg)

      // Allow microtasks to run
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(onKeyVersionMissing).toHaveBeenCalledWith('2')
      expect(waitForKeyVersion).toHaveBeenCalledWith('2', 1000)
      expect(messageListener).not.toHaveBeenCalled()

      // Now the key arrives
      resolveKeyWait(true)

      await vi.waitFor(() => {
        expect(messageListener).toHaveBeenCalledTimes(1)
      })

      expect(messageListener).toHaveBeenCalledWith({
        ...msg,
        data: new Uint8Array([7, 8, 9]),
      })
    })

    it('buffers message and continues queue if waitForKeyVersion times out, decrypting when key arrives', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onKeyVersionMissing = vi.fn()
      const adapterWithMissingKey = new EncryptedBroadcastChannelNetworkAdapter({
        channelName: 'test-channel',
        onKeyVersionMissing,
        keyWaitTimeoutMs: 50,
      })
      const innerMock = (adapterWithMissingKey as any).inner
      const messageListener = vi.fn()
      adapterWithMissingKey.on('message', messageListener)

      let innerCallback: any
      for (const call of innerMock.on.mock.calls) {
        if (call[0] === 'message') innerCallback = call[1]
      }

      const { hasVaultKey, waitForKeyVersion } = await import('src/api/vault')
      let key3Available = false
      vi.mocked(hasVaultKey).mockImplementation((kver?: string) => {
        if (kver === '3') return key3Available
        return true
      })

      const keyWaitResolvers: Array<(val: boolean) => void> = []
      vi.mocked(waitForKeyVersion).mockImplementation((kver: string) => {
        if (kver === '3' && !key3Available) {
          return new Promise(resolve => {
            keyWaitResolvers.push(resolve)
          })
        }
        return Promise.resolve(true)
      })

      const badPayload = { iv: 'iv-k3', cipher: 'mock-cipher-1,2', kver: '3', version: '1.0' }
      const goodPayload = { iv: 'iv-k1', cipher: 'mock-cipher-3,4', kver: '1', version: '1.0' }

      const msg1: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'doc1' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(badPayload)),
      }

      const msg2: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'doc2' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(goodPayload)),
      }

      innerCallback(msg1)
      innerCallback(msg2)

      // Wait for msg1 to start waiting on key 3
      await vi.waitFor(() => {
        expect(keyWaitResolvers.length).toBeGreaterThan(0)
      })

      // Simulate timeout for msg1
      const initialResolver = keyWaitResolvers.shift()
      initialResolver?.(false)

      // msg2 (kver 1) should be emitted while msg1 is buffered
      await vi.waitFor(() => {
        expect(messageListener).toHaveBeenCalledTimes(1)
      })

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[EncryptedBroadcastChannel] Timed out waiting for key version 3. Buffering message until key arrives.'
      )
      expect(messageListener).toHaveBeenCalledWith({
        ...msg2,
        data: new Uint8Array([3, 4]),
      })

      // Now key 3 arrives
      key3Available = true
      for (const res of keyWaitResolvers) {
        res(true)
      }
      keyWaitResolvers.length = 0

      // Buffered msg1 should now be decrypted and emitted without data loss
      await vi.waitFor(() => {
        expect(messageListener).toHaveBeenCalledTimes(2)
      })

      expect(messageListener).toHaveBeenLastCalledWith({
        ...msg1,
        data: new Uint8Array([1, 2]),
      })

      consoleWarnSpy.mockRestore()
    })

    it('buffers multiple messages for missing key and delivers all in order once key propagates', async () => {
      const onKeyVersionMissing = vi.fn()
      const adapter = new EncryptedBroadcastChannelNetworkAdapter({
        channelName: 'test-channel',
        onKeyVersionMissing,
        keyWaitTimeoutMs: 50,
      })
      const innerMock = (adapter as any).inner
      const messageListener = vi.fn()
      adapter.on('message', messageListener)

      let innerCallback: any
      for (const call of innerMock.on.mock.calls) {
        if (call[0] === 'message') innerCallback = call[1]
      }

      const { hasVaultKey, waitForKeyVersion } = await import('src/api/vault')
      let key4Available = false
      vi.mocked(hasVaultKey).mockImplementation((kver?: string) => {
        if (kver === '4') return key4Available
        return true
      })

      const keyWaitResolvers: Array<(val: boolean) => void> = []
      vi.mocked(waitForKeyVersion).mockImplementation((kver: string) => {
        if (kver === '4' && !key4Available) {
          return new Promise(resolve => {
            keyWaitResolvers.push(resolve)
          })
        }
        return Promise.resolve(true)
      })

      const payload1 = { iv: 'iv-1', cipher: 'mock-cipher-10,11', kver: '4', version: '1.0' }
      const payload2 = { iv: 'iv-2', cipher: 'mock-cipher-12,13', kver: '4', version: '1.0' }

      const msgA: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'docA' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(payload1)),
      }

      const msgB: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'docB' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(payload2)),
      }

      innerCallback(msgA)
      innerCallback(msgB)

      // Wait for msgA to start waiting
      await vi.waitFor(() => {
        expect(keyWaitResolvers.length).toBeGreaterThan(0)
      })

      // Simulate timeout
      const initialResolver = keyWaitResolvers.shift()
      initialResolver?.(false)

      // Allow queue to process and buffer msgA and msgB
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(messageListener).not.toHaveBeenCalled()

      // Key 4 arrives
      key4Available = true
      for (const res of keyWaitResolvers) {
        res(true)
      }
      keyWaitResolvers.length = 0

      await vi.waitFor(() => {
        expect(messageListener).toHaveBeenCalledTimes(2)
      })

      expect(messageListener.mock.calls[0][0]).toEqual({
        ...msgA,
        data: new Uint8Array([10, 11]),
      })
      expect(messageListener.mock.calls[1][0]).toEqual({
        ...msgB,
        data: new Uint8Array([12, 13]),
      })
    })
  })

  describe('cross-tab new item discovery', () => {
    it('publishes realtime bus sync ping when sending a sync message for an item', async () => {
      const docId = toDocumentIdFromItemId('item-abc' as ItemId)
      const message: Message = {
        type: 'sync',
        senderId: 'peer1' as PeerId,
        targetId: 'peer2' as PeerId,
        documentId: docId,
        data: new Uint8Array([1, 2, 3]),
      }

      mockPublishRealtimeBusSyncPing.mockClear()
      adapter.send(message)

      await vi.waitFor(() => {
        expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith('account-1', ['item-abc'])
      })
    })

    it('does not publish realtime bus sync ping for ACCOUNT_INDEX_DOCUMENT_ID', async () => {
      const message: Message = {
        type: 'sync',
        senderId: 'peer1' as PeerId,
        targetId: 'peer2' as PeerId,
        documentId: ACCOUNT_INDEX_DOCUMENT_ID as unknown as DocumentId,
        data: new Uint8Array([1, 2]),
      }

      mockPublishRealtimeBusSyncPing.mockClear()
      adapter.send(message)

      await new Promise(resolve => setTimeout(resolve, 30))
      expect(mockPublishRealtimeBusSyncPing).not.toHaveBeenCalled()
    })

    it('invokes onDocumentReceived callback when receiving a sync message', async () => {
      const onDocumentReceived = vi.fn()
      const customAdapter = new EncryptedBroadcastChannelNetworkAdapter({ onDocumentReceived })
      const innerCustomAdapterMock = (customAdapter as any).inner

      let innerMessageCallback: any
      for (const call of innerCustomAdapterMock.on.mock.calls) {
        if (call[0] === 'message') innerMessageCallback = call[1]
      }

      const docId = toDocumentIdFromItemId('item-xyz' as ItemId)
      const cryptoResult = {
        iv: 'mock-iv',
        cipher: 'mock-cipher-1,2',
        kver: '1',
        version: '1.0',
      }
      const encryptedData = new TextEncoder().encode(JSON.stringify(cryptoResult))
      const incomingMessage: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: docId,
        data: encryptedData,
      }

      innerMessageCallback(incomingMessage)

      await vi.waitFor(() => {
        expect(onDocumentReceived).toHaveBeenCalledWith(docId)
      })
    })

    it('pauses and resumes sending and receiving messages', async () => {
      const mockMessageListener = vi.fn()
      adapter.on('message', mockMessageListener)

      let innerMessageCallback: any
      for (const call of innerAdapterMock.on.mock.calls) {
        if (call[0] === 'message') innerMessageCallback = call[1]
      }

      expect(adapter.isSyncPaused()).toBe(false)
      adapter.pause()
      expect(adapter.isSyncPaused()).toBe(true)

      // Send while paused
      const message: Message = {
        type: 'sync',
        senderId: 'peer1' as PeerId,
        targetId: 'peer2' as PeerId,
        documentId: 'doc1' as DocumentId,
        data: new Uint8Array([1, 2]),
      }
      adapter.send(message)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(innerAdapterMock.send).not.toHaveBeenCalled()

      // Receive while paused
      const incomingMessage: Message = {
        type: 'doc',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'doc1' as DocumentId,
      }
      innerMessageCallback(incomingMessage)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(mockMessageListener).not.toHaveBeenCalled()

      // Resume
      adapter.resume()
      expect(adapter.isSyncPaused()).toBe(false)

      adapter.send(message)
      await vi.waitFor(() => {
        expect(innerAdapterMock.send).toHaveBeenCalledTimes(1)
      })

      innerMessageCallback(incomingMessage)
      await vi.waitFor(() => {
        expect(mockMessageListener).toHaveBeenCalledWith(incomingMessage)
      })
    })
  })

  describe('Crypto retry behavior and queue retention', () => {
    it('does not shift message from sendQueue while retrying encryption, retaining it until success', async () => {
      const { encryptBytes } = await import('src/api/vault')
      const retryAdapter = new EncryptedBroadcastChannelNetworkAdapter({
        cryptoRetryDelayMs: 0,
      })
      const innerMock = (retryAdapter as any).inner

      let resolveRetryWait!: () => void
      const retryWaitPromise = new Promise<void>(res => {
        resolveRetryWait = res
      })

      let attempts = 0
      vi.mocked(encryptBytes).mockImplementation(async (bytes: Uint8Array) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('Transient encrypt error')
        }
        await retryWaitPromise
        return {
          iv: 'mock-iv',
          cipher: 'mock-cipher-' + Array.from(bytes).join(','),
          kver: '1',
          version: '1.0',
        }
      })

      const message: Message = {
        type: 'sync',
        senderId: 'peer1' as PeerId,
        targetId: 'peer2' as PeerId,
        documentId: 'docRetrySend' as DocumentId,
        data: new Uint8Array([50, 51]),
      }

      retryAdapter.send(message)

      // During second attempt (awaiting retryWaitPromise), the message must still be at the head of sendQueue with retries: 1
      await vi.waitFor(() => {
        expect(attempts).toBe(2)
        expect((retryAdapter as any).sendQueue.length).toBe(1)
        expect((retryAdapter as any).sendQueue[0].retries).toBe(1)
      })

      // Resolve retry wait promise to let attempt 2 complete
      resolveRetryWait()

      // The retry succeeds and shifts the message from sendQueue
      await vi.waitFor(() => {
        expect((retryAdapter as any).sendQueue.length).toBe(0)
        expect(innerMock.send).toHaveBeenCalledTimes(1)
      })
    })

    it('does not shift message from receiveQueue while retrying decryption, retaining it until success', async () => {
      const { decryptBytes } = await import('src/api/vault')
      const retryAdapter = new EncryptedBroadcastChannelNetworkAdapter({
        cryptoRetryDelayMs: 0,
      })
      const innerMock = (retryAdapter as any).inner
      const messageListener = vi.fn()
      retryAdapter.on('message', messageListener)

      let innerCallback: any
      for (const call of innerMock.on.mock.calls) {
        if (call[0] === 'message') innerCallback = call[1]
      }

      let resolveRetryWait!: () => void
      const retryWaitPromise = new Promise<void>(res => {
        resolveRetryWait = res
      })

      let attempts = 0
      vi.mocked(decryptBytes).mockImplementation(async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('Transient decrypt error')
        }
        await retryWaitPromise
        return new Uint8Array([70, 71])
      })

      const payload = { iv: 'iv', cipher: 'mock-cipher-70,71', kver: '1', version: '1.0' }
      const incomingMessage: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'docRetryRecv' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(payload)),
      }

      innerCallback(incomingMessage)

      // During second attempt (awaiting retryWaitPromise), message must still be retained at head of receiveQueue with retries: 1
      await vi.waitFor(() => {
        expect(attempts).toBe(2)
        expect((retryAdapter as any).receiveQueue.length).toBe(1)
        expect((retryAdapter as any).receiveQueue[0].retries).toBe(1)
      })

      // Resolve retry wait promise to let attempt 2 complete
      resolveRetryWait()

      // The retry succeeds and shifts from receiveQueue, emitting message
      await vi.waitFor(() => {
        expect((retryAdapter as any).receiveQueue.length).toBe(0)
        expect(messageListener).toHaveBeenCalledTimes(1)
      })
    })

    it('shifts message from sendQueue only after maxCryptoRetries attempts are exhausted', async () => {
      const { encryptBytes } = await import('src/api/vault')
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const retryAdapter = new EncryptedBroadcastChannelNetworkAdapter({
        maxCryptoRetries: 2,
        cryptoRetryDelayMs: 0,
      })

      let calls = 0
      vi.mocked(encryptBytes).mockImplementation(async () => {
        calls += 1
        throw new Error('Permanent failure')
      })

      const message: Message = {
        type: 'sync',
        senderId: 'peer1' as PeerId,
        targetId: 'peer2' as PeerId,
        documentId: 'docExhaustSend' as DocumentId,
        data: new Uint8Array([80]),
      }

      retryAdapter.send(message)

      await vi.waitFor(() => {
        expect(calls).toBe(2)
        expect((retryAdapter as any).sendQueue.length).toBe(0)
      })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[EncryptedBroadcastChannel] Error sending message:',
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })

    it('shifts message from receiveQueue only after maxCryptoRetries attempts are exhausted', async () => {
      const { decryptBytes } = await import('src/api/vault')
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const retryAdapter = new EncryptedBroadcastChannelNetworkAdapter({
        maxCryptoRetries: 2,
        cryptoRetryDelayMs: 0,
      })
      const innerMock = (retryAdapter as any).inner

      let innerCallback: any
      for (const call of innerMock.on.mock.calls) {
        if (call[0] === 'message') innerCallback = call[1]
      }

      let calls = 0
      vi.mocked(decryptBytes).mockImplementation(async () => {
        calls += 1
        throw new Error('Permanent decrypt failure')
      })

      const payload = { iv: 'iv', cipher: 'mock-cipher-80', kver: '1', version: '1.0' }
      const incomingMessage: Message = {
        type: 'sync',
        senderId: 'peer2' as PeerId,
        targetId: 'peer1' as PeerId,
        documentId: 'docExhaustRecv' as DocumentId,
        data: new TextEncoder().encode(JSON.stringify(payload)),
      }

      innerCallback(incomingMessage)

      await vi.waitFor(() => {
        expect(calls).toBe(2)
        expect((retryAdapter as any).receiveQueue.length).toBe(0)
      })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[EncryptedBroadcastChannel] Error decrypting message:',
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })
  })
})

