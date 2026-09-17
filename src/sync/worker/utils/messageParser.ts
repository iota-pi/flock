import { DocumentId } from '@automerge/automerge-repo/slim'
import { ItemId } from 'src/shared/schemas/items'

export interface ParseBatchedMessagesOptions {
  startIndex?: number
  onMessageSuccess?: (index: number) => void
}

export function parseBatchedMessages(
  itemId: ItemId,
  documentId: DocumentId,
  decrypted: Uint8Array,
  onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void,
  options?: ParseBatchedMessagesOptions
): boolean {
  let offset = 0
  let index = 0
  let success = true
  const startIndex = options?.startIndex ?? 0
  const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)

  while (offset < decrypted.byteLength) {
    try {
      if (offset + 4 > decrypted.byteLength) {
        throw new Error('Unexpected end of batch header')
      }
      const length = view.getUint32(offset, false)
      offset += 4
      if (offset + length > decrypted.byteLength) {
        throw new Error('Unexpected end of batch payload')
      }

      const currentIndex = index += 1
      if (currentIndex < startIndex) {
        offset += length
        continue
      }

      const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
      offset += length

      try {
        onMessageParsed(itemId, documentId, msg)
        options?.onMessageSuccess?.(currentIndex)
      } catch (error) {
        console.error('[messageParser] Error processing message in batch', error)
        success = false
        break
      }
    } catch (error) {
      console.error('[messageParser] Error parsing message batch structure', error)
      success = false
      break
    }
  }
  return success
}
