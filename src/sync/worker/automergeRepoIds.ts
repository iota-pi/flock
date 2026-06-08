import {
  DocumentId,
  documentIdToBinary,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type BinaryDocumentId,
} from '@automerge/automerge-repo/slim'
import { ItemId } from 'src/shared/schemas/items'


export function toAutomergeUrlFromItemId(itemId: ItemId): AutomergeUrl {
  const binary = new TextEncoder().encode(itemId)
  return stringifyAutomergeUrl(binary as BinaryDocumentId)
}

export function toVaultItemIdFromAutomergeId(documentId: DocumentId): ItemId {
  if (documentId.length === 0) {
    return documentId as unknown as ItemId
  }

  try {
    const binary = documentIdToBinary(documentId)
    if (!binary) {
      return documentId as unknown as ItemId
    }
    return new TextDecoder().decode(binary) as ItemId
  } catch {
    // If decoding fails (e.g. legacy fallback or test mocks), return the normalized document ID
    return documentId as unknown as ItemId
  }
}
