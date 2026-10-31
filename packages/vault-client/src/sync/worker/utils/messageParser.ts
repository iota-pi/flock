import { MAX_ITEM_SIZE_BYTES } from '@vault/shared'
import { createLogger } from '../../utils/logger'

const log = createLogger('messageParser')

export interface ParseBatchedMessagesOptions {
  startIndex?: number
  onMessageSuccess?: (index: number) => void
}

export function parseBatchedMessages(
  decrypted: Uint8Array,
  onMessageParsed: (message: Uint8Array) => void,
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
      if (length === 0) {
        throw new Error('Zero-length message in batch')
      }
      if (length > MAX_ITEM_SIZE_BYTES) {
        throw new Error(`Batched message length (${length}) exceeds maximum limit (${MAX_ITEM_SIZE_BYTES})`)
      }
      if (offset + length > decrypted.byteLength) {
        throw new Error('Unexpected end of batch payload')
      }

      const currentIndex = index
      index += 1
      if (currentIndex < startIndex) {
        offset += length
        continue
      }

      const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
      offset += length

      try {
        onMessageParsed(msg)
        options?.onMessageSuccess?.(currentIndex)
      } catch (error) {
        log.error('Error processing message in batch', error)
        success = false
        break
      }
    } catch (error) {
      log.error('Error parsing message batch structure', error)
      success = false
      break
    }
  }
  return success
}
