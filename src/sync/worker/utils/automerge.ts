import {
  DocumentId,
  documentIdToBinary,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type BinaryDocumentId,
  type DocHandle,
} from '@automerge/automerge-repo/slim'
import type { $brand } from 'zod'
import { ItemId } from 'src/shared/schemas/items'
import { isPlainObject } from './objectUtils'

export type IndexDocId = string & $brand<'IndexDocId'>
export const ACCOUNT_INDEX_DOCUMENT_ID = '__account_index__' as IndexDocId
export type BackupDocId = ItemId | IndexDocId

export function readObjectSnapshot<TDoc extends object>(
  handle: DocHandle<TDoc>,
): TDoc | null {
  try {
    if (!handle.isReady()) {
      return null
    }
    const doc = handle.doc()
    return isPlainObject(doc) ? (doc as TDoc) : null
  } catch {
    return null
  }
}

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
