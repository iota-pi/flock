import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type BinaryDocumentId,
} from '@automerge/automerge-repo/slim'

const AUTOMERGE_URL_PREFIX = 'automerge:'

const documentIdByItemId = new Map<string, string>()
const itemIdByDocumentId = new Map<string, string>()

async function hashItemIdToBinary(itemId: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const data = enc.encode(itemId)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hashBuffer, 0, 16)
}

async function ensureMapping(itemId: string): Promise<string> {
  const existingDocumentId = documentIdByItemId.get(itemId)
  if (existingDocumentId) {
    return existingDocumentId
  }

  const binary = await hashItemIdToBinary(itemId)
  const url = stringifyAutomergeUrl(binary as BinaryDocumentId)
  const { documentId } = parseAutomergeUrl(url)

  documentIdByItemId.set(itemId, documentId)
  itemIdByDocumentId.set(documentId, itemId)

  return documentId
}

export async function toAutomergeUrlFromItemId(itemId: string): Promise<AutomergeUrl> {
  const documentId = await ensureMapping(itemId)
  return `automerge:${documentId}` as AutomergeUrl
}

function normalizeDocumentId(documentId: string): string {
  let normalizedDocumentId = documentId

  if (documentId.startsWith(AUTOMERGE_URL_PREFIX)) {
    try {
      normalizedDocumentId = parseAutomergeUrl(documentId as AutomergeUrl).documentId
    } catch {
      normalizedDocumentId = documentId.slice(AUTOMERGE_URL_PREFIX.length)
    }
  }

  return normalizedDocumentId
}

export function toVaultItemIdFromAutomergeId(documentId: string): string {
  if (documentId.length === 0) {
    return documentId
  }

  const normalizedDocumentId = normalizeDocumentId(documentId)

  return (
    itemIdByDocumentId.get(normalizedDocumentId)
    || itemIdByDocumentId.get(documentId)
    // documentId should always be in the map, but in case, the documentId is usually the same as the itemId, so we can return it as a fallback
    || normalizedDocumentId
  )
}
