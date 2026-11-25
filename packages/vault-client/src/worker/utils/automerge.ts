import {
  type DocumentId,
  documentIdToBinary,
  interpretAsDocumentId,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type BinaryDocumentId,
  type DocHandle,
} from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import type { $brand } from 'zod'
import type { ItemId } from '@vault/shared'
import { isPlainObject } from './objectUtils'

export type IndexDocId = string & $brand<'IndexDocId'>
export const ACCOUNT_INDEX_DOCUMENT_ID = '__account_index__' as IndexDocId
export type BackupDocId = ItemId | IndexDocId

/** Whether an ID names the account item index rather than an item */
export function isIndexDocument(id: string): boolean {
  return id === ACCOUNT_INDEX_DOCUMENT_ID
}

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

export function toDocumentIdFromItemId(itemId: ItemId): DocumentId {
  return interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))
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
    return new TextDecoder('utf-8', { fatal: true }).decode(binary) as ItemId
  } catch {
    // If decoding fails (e.g. legacy fallback or test mocks), return the normalized document ID
    return documentId as unknown as ItemId
  }
}

export function areHeadsEqual(a?: string[], b?: string[]): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  if (a.length === 0) return true
  if (a.length === 1) return a[0] === b[0]
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false
  }
  return true
}

/**
 * The frontier of `heads` in `doc`: those it has, less any that's an ancestor of another, so the
 * result names exactly the changes `heads` does. `Automerge.view` keeps a set as it's given, so it
 * can't reduce one. Each head costs a walk of what the doc has after it, so this is for a few recent
 * heads, such as server heads and a snapshot's.
 */
export function frontierOf(doc: Automerge.Doc<unknown>, heads: string[]): string[] {
  const known = Array.from(new Set(heads)).filter(head => Automerge.hasHeads(doc, [head]))
  if (known.length <= 1) return known
  const ancestors = new Set<string>()
  for (const head of known) {
    if (ancestors.has(head)) continue
    // What the doc has after `head` excludes `head` and its ancestors
    const after = new Set(Automerge.getChangesMetaSince(doc, [head]).map(change => change.hash))
    for (const other of known) {
      if (other !== head && !after.has(other)) ancestors.add(other)
    }
  }
  return known.filter(head => !ancestors.has(head))
}
