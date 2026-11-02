/** The `version` of an encrypted sync message whose payload is a batch packed by packBatchedMessages */
export const BATCHED_MESSAGE_VERSION = '1.0'

/**
 * Combines multiple messages for an item into a length-prefixed batched stream.
 * Compatible with parseBatchedMessages on the receiving end.
 */
export function packBatchedMessages(messages: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const message of messages) {
    totalLength += 4 + message.length
  }
  const combined = new Uint8Array(totalLength)
  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength)
  let offset = 0
  for (const message of messages) {
    view.setUint32(offset, message.length, false)
    offset += 4
    combined.set(message, offset)
    offset += message.length
  }
  return combined
}
