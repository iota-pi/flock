import { DocumentId } from '@automerge/automerge-repo/slim'
import { ItemId } from 'src/shared/schemas/items'

export function parseBatchedMessages(
  itemId: ItemId,
  documentId: DocumentId,
  decrypted: Uint8Array,
  onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void
): boolean {
  let offset = 0
  let success = true
  const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)
  while (offset < decrypted.byteLength) {
    try {
      const length = view.getUint32(offset, false)
      offset += 4
      const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
      offset += length

      try {
        onMessageParsed(itemId, documentId, msg)
      } catch (error) {
        console.error('[messageParser] Error processing message in batch', error)
        success = false
      }
    } catch (error) {
      console.error('[messageParser] Error parsing message batch structure', error)
      success = false
      break
    }
  }
  return success
}
