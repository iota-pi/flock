import { parseBatchedMessages } from './messageParser'
import { ItemId } from 'src/shared/schemas/items'
import { DocumentId } from '@automerge/automerge-repo/slim'

describe('parseBatchedMessages', () => {
  it('correctly parses messages with length prefixes', () => {
    const onMessageParsed = vi.fn()
    const msg1 = new Uint8Array([1, 2])
    const msg2 = new Uint8Array([3, 4, 5])

    const combined = new Uint8Array(4 + 2 + 4 + 3)
    const view = new DataView(combined.buffer)
    view.setUint32(0, 2, false)
    combined.set(msg1, 4)
    view.setUint32(6, 3, false)
    combined.set(msg2, 10)

    const result = parseBatchedMessages(
      'item-1' as ItemId,
      'doc-1' as DocumentId,
      combined,
      onMessageParsed
    )

    expect(result).toBe(true)
    expect(onMessageParsed).toHaveBeenCalledTimes(2)
    expect(onMessageParsed).toHaveBeenNthCalledWith(1, 'item-1', 'doc-1', msg1)
    expect(onMessageParsed).toHaveBeenNthCalledWith(2, 'item-1', 'doc-1', msg2)
  })

  it('returns false and halts when onMessageParsed throws', () => {
    const onMessageParsed = vi.fn().mockImplementation((itemId, docId, msg) => {
      if (msg[0] === 1) {
        throw new Error('Processing failed')
      }
    })
    const msg1 = new Uint8Array([1, 2])
    const msg2 = new Uint8Array([3, 4, 5])

    const combined = new Uint8Array(4 + 2 + 4 + 3)
    const view = new DataView(combined.buffer)
    view.setUint32(0, 2, false)
    combined.set(msg1, 4)
    view.setUint32(6, 3, false)
    combined.set(msg2, 10)

    const result = parseBatchedMessages(
      'item-1' as ItemId,
      'doc-1' as DocumentId,
      combined,
      onMessageParsed
    )

    expect(result).toBe(false)
    // Halts immediately to preserve batch order
    expect(onMessageParsed).toHaveBeenCalledTimes(1)
  })

  it('skips messages before startIndex without invoking onMessageParsed', () => {
    const onMessageParsed = vi.fn()
    const onMessageSuccess = vi.fn()
    const msg1 = new Uint8Array([1, 2])
    const msg2 = new Uint8Array([3, 4, 5])

    const combined = new Uint8Array(4 + 2 + 4 + 3)
    const view = new DataView(combined.buffer)
    view.setUint32(0, 2, false)
    combined.set(msg1, 4)
    view.setUint32(6, 3, false)
    combined.set(msg2, 10)

    const result = parseBatchedMessages(
      'item-1' as ItemId,
      'doc-1' as DocumentId,
      combined,
      onMessageParsed,
      {
        startIndex: 1,
        onMessageSuccess,
      }
    )

    expect(result).toBe(true)
    expect(onMessageParsed).toHaveBeenCalledTimes(1)
    expect(onMessageParsed).toHaveBeenCalledWith('item-1', 'doc-1', msg2)
    expect(onMessageSuccess).toHaveBeenCalledTimes(1)
    expect(onMessageSuccess).toHaveBeenCalledWith(1)
  })

  it('calls onMessageSuccess for each message that succeeds until failure', () => {
    const onMessageParsed = vi.fn().mockImplementation((itemId, docId, msg) => {
      if (msg[0] === 3) {
        throw new Error('Processing failed for message 2')
      }
    })
    const onMessageSuccess = vi.fn()
    const msg1 = new Uint8Array([1, 2])
    const msg2 = new Uint8Array([3, 4, 5])

    const combined = new Uint8Array(4 + 2 + 4 + 3)
    const view = new DataView(combined.buffer)
    view.setUint32(0, 2, false)
    combined.set(msg1, 4)
    view.setUint32(6, 3, false)
    combined.set(msg2, 10)

    const result = parseBatchedMessages(
      'item-1' as ItemId,
      'doc-1' as DocumentId,
      combined,
      onMessageParsed,
      {
        onMessageSuccess,
      }
    )

    expect(result).toBe(false)
    expect(onMessageParsed).toHaveBeenCalledTimes(2)
    expect(onMessageSuccess).toHaveBeenCalledTimes(1)
    expect(onMessageSuccess).toHaveBeenCalledWith(0)
  })

  it('returns false when message batch structure is malformed', () => {
    const onMessageParsed = vi.fn()
    const malformed = new Uint8Array([0, 0]) // Less than 4 bytes for length prefix

    const result = parseBatchedMessages(
      'item-1' as ItemId,
      'doc-1' as DocumentId,
      malformed,
      onMessageParsed
    )

    expect(result).toBe(false)
    expect(onMessageParsed).not.toHaveBeenCalled()
  })
})
