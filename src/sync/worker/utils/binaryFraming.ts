export interface BatchableMessage {
  data: Uint8Array
  isBatched?: boolean
}

/**
 * Combines multiple messages for an item into a length-prefixed batched stream.
 * Compatible with parseBatchedMessages on the receiving end.
 */
export function packBatchedMessages(entries: readonly BatchableMessage[]): Uint8Array {
  let totalLength = 0
  for (const e of entries) {
    if (e.isBatched) {
      totalLength += e.data.length
    } else {
      totalLength += 4 + e.data.length
    }
  }
  const combined = new Uint8Array(totalLength)
  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength)
  let offset = 0
  for (const e of entries) {
    if (e.isBatched) {
      combined.set(e.data, offset)
      offset += e.data.length
    } else {
      view.setUint32(offset, e.data.length, false)
      offset += 4
      combined.set(e.data, offset)
      offset += e.data.length
    }
  }
  return combined
}
