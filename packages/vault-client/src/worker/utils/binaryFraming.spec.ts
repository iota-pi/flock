import { packBatchedMessages } from './binaryFraming'
import { parseBatchedMessages } from './messageParser'

describe('binaryFraming', () => {
  describe('packBatchedMessages', () => {
    it('returns empty Uint8Array for empty entries', () => {
      const packed = packBatchedMessages([])
      expect(packed).toHaveLength(0)
    })

    it('packs a single message with a 4-byte big-endian length prefix', () => {
      const msg = new Uint8Array([10, 20, 30])
      const packed = packBatchedMessages([msg])

      expect(packed.length).toBe(4 + 3)
      const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
      expect(view.getUint32(0, false)).toBe(3)
      expect(packed.slice(4)).toEqual(msg)
    })

    it('packs multiple messages sequentially with length prefixes', () => {
      const msg1 = new Uint8Array([1, 2])
      const msg2 = new Uint8Array([3, 4, 5, 6])
      const packed = packBatchedMessages([msg1, msg2])

      expect(packed.length).toBe(4 + 2 + 4 + 4)
      const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength)
      expect(view.getUint32(0, false)).toBe(2)
      expect(packed.slice(4, 6)).toEqual(msg1)
      expect(view.getUint32(6, false)).toBe(4)
      expect(packed.slice(10, 14)).toEqual(msg2)
    })

    it('is fully compatible round-trip with parseBatchedMessages', () => {
      const messages = [
        new Uint8Array([0xaa, 0xbb]),
        new Uint8Array([0xcc, 0xdd, 0xee]),
        new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
      ]

      const packed = packBatchedMessages(messages)

      const parsed: Uint8Array[] = []
      const result = parseBatchedMessages(
        packed,
        msg => {
          parsed.push(new Uint8Array(msg))
        }
      )

      expect(result).toBe(true)
      expect(parsed).toEqual(messages)
    })
  })
})
