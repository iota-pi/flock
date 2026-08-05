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

    parseBatchedMessages(
      'item-1' as ItemId,
      'doc-1' as DocumentId,
      combined,
      onMessageParsed
    )

    expect(onMessageParsed).toHaveBeenCalledTimes(2)
    expect(onMessageParsed).toHaveBeenNthCalledWith(1, 'item-1', 'doc-1', msg1)
    expect(onMessageParsed).toHaveBeenNthCalledWith(2, 'item-1', 'doc-1', msg2)
  })
})
