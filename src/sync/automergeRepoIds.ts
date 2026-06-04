import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type BinaryDocumentId,
} from '@automerge/automerge-repo/slim'

const AUTOMERGE_URL_PREFIX = 'automerge:'

const documentIdByItemId = new Map<string, string>()
const itemIdByDocumentId = new Map<string, string>()
const urlByItemId = new Map<string, AutomergeUrl>()

async function hashItemIdToBinary(itemId: string): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const data = enc.encode(itemId)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hashBuffer, 0, 16)
}

async function ensureMapping(itemId: string): Promise<{ url: AutomergeUrl; documentId: string }> {
  const existingUrl = urlByItemId.get(itemId)
  const existingDocumentId = documentIdByItemId.get(itemId)
  if (existingUrl && existingDocumentId) {
    return {
      url: existingUrl,
      documentId: existingDocumentId,
    }
  }

  const binary = await hashItemIdToBinary(itemId)
  const url = stringifyAutomergeUrl(binary as BinaryDocumentId)
  const { documentId } = parseAutomergeUrl(url)

  urlByItemId.set(itemId, url)
  documentIdByItemId.set(itemId, documentId)
  itemIdByDocumentId.set(documentId, itemId)

  return {
    url,
    documentId,
  }
}

export async function toAutomergeUrlFromItemId(itemId: string): Promise<AutomergeUrl> {
  const mapping = await ensureMapping(itemId)
  return mapping.url
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
