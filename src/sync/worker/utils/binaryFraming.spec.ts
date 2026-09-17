import { packBatchedMessages } from './binaryFraming'
import { parseBatchedMessages } from './messageParser'
import type { ItemId } from 'src/shared/schemas/items'
import type { DocumentId } from '@automerge/automerge-repo/slim'

describe('binaryFraming', () => {
  describe('packBatchedMessages', () => {
    it('returns empty Uint8Array for empty entries', () => {
      const packed = packBatchedMessages([])
      expect(packed).toHaveLength(0)
    })

    it('packs a single unbatched message with a 4-byte big-endian length prefix', () => {
      const msg = new Uint8Array([10, 20, 30])
      const packed = packBatchedMessages([{ data: msg }])

      expect(packed.length).toBe(4 + 3)
      const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
      expect(view.getUint32(0, false)).toBe(3)
      expect(packed.slice(4)).toEqual(msg)
    })

    it('packs multiple unbatched messages sequentially with length prefixes', () => {
      const msg1 = new Uint8Array([1, 2])
      const msg2 = new Uint8Array([3, 4, 5, 6])
      const packed = packBatchedMessages([{ data: msg1 }, { data: msg2 }])

      expect(packed.length).toBe(4 + 2 + 4 + 4)
      const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
      expect(view.getUint32(0, false)).toBe(2)
      expect(packed.slice(4, 6)).toEqual(msg1)
      expect(view.getUint32(6, false)).toBe(4)
      expect(packed.slice(10, 14)).toEqual(msg2)
    })

    it('passes through already-batched messages without adding an extra length prefix', () => {
      const sub1 = new Uint8Array([1, 2])
      const sub2 = new Uint8Array([3, 4, 5])
      const batchedStream = packBatchedMessages([{ data: sub1 }, { data: sub2 }])

      // When marked as isBatched: true, its length should be preserved as-is
      const repacked = packBatchedMessages([{ data: batchedStream, isBatched: true }])
      expect(repacked).toEqual(batchedStream)
    })

    it('handles mixed batched and unbatched messages', () => {
      const unbatched1 = new Uint8Array([1, 2])
      const alreadyBatched = packBatchedMessages([{ data: new Uint8Array([3, 4]) }])
      const unbatched2 = new Uint8Array([5, 6, 7])

      const packed = packBatchedMessages([
        { data: unbatched1 },
        { data: alreadyBatched, isBatched: true },
        { data: unbatched2 },
      ])

      const expectedLength = (4 + 2) + alreadyBatched.length + (4 + 3)
      expect(packed.length).toBe(expectedLength)

      const parsedMessages: Uint8Array[] = []
      const success = parseBatchedMessages(
        'item-test' as ItemId,
        'doc-test' as DocumentId,
        packed,
        (_itemId, _docId, msg) => {
          parsedMessages.push(new Uint8Array(msg))
        }
      )

      expect(success).toBe(true)
      expect(parsedMessages).toHaveLength(3)
      expect(parsedMessages[0]).toEqual(new Uint8Array([1, 2]))
      expect(parsedMessages[1]).toEqual(new Uint8Array([3, 4]))
      expect(parsedMessages[2]).toEqual(new Uint8Array([5, 6, 7]))
    })

    it('is fully compatible round-trip with parseBatchedMessages', () => {
      const messages = [
        new Uint8Array([0xaa, 0xbb]),
        new Uint8Array([0xcc, 0xdd, 0xee]),
        new Uint8Array([]), // empty payload message
        new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
      ]

      const packed = packBatchedMessages(messages.map(data => ({ data })))

      const parsed: Uint8Array[] = []
      const result = parseBatchedMessages(
        'item-roundtrip' as ItemId,
        'doc-roundtrip' as DocumentId,
        packed,
        (_itemId, _docId, msg) => {
          parsed.push(new Uint8Array(msg))
        }
      )

      expect(result).toBe(true)
      expect(parsed).toEqual(messages)
    })
  })
})
