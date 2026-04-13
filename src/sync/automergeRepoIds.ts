import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type AnyDocumentId,
  type BinaryDocumentId,
} from '@automerge/automerge-repo/slim'

const AUTOMERGE_URL_PREFIX = 'automerge:'

const documentIdByItemId = new Map<string, string>()
const itemIdByDocumentId = new Map<string, string>()
const urlByItemId = new Map<string, AutomergeUrl>()

function hashItemIdToBinary(itemId: string): Uint8Array {
  // cyrb128-style deterministic hash to a 16-byte Automerge document id seed.
  let h1 = 1_779_033_703
  let h2 = 3_144_134_277
  let h3 = 1_013_904_242
  let h4 = 2_773_480_762

  for (let index = 0; index < itemId.length; index += 1) {
    const code = itemId.charCodeAt(index)
    h1 = h2 ^ Math.imul(h1 ^ code, 597_399_067)
    h2 = h3 ^ Math.imul(h2 ^ code, 2_869_860_233)
    h3 = h4 ^ Math.imul(h3 ^ code, 951_274_213)
    h4 = h1 ^ Math.imul(h4 ^ code, 2_716_044_179)
  }

  h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179)

  const output = new Uint8Array(16)
  const view = new DataView(output.buffer)
  view.setUint32(0, h1 >>> 0, false)
  view.setUint32(4, h2 >>> 0, false)
  view.setUint32(8, h3 >>> 0, false)
  view.setUint32(12, h4 >>> 0, false)
  return output
}

function ensureMapping(itemId: string): { url: AutomergeUrl; documentId: string } {
  const existingUrl = urlByItemId.get(itemId)
  const existingDocumentId = documentIdByItemId.get(itemId)
  if (existingUrl && existingDocumentId) {
    return {
      url: existingUrl,
      documentId: existingDocumentId,
    }
  }

  const url = stringifyAutomergeUrl(hashItemIdToBinary(itemId) as BinaryDocumentId)
  const { documentId } = parseAutomergeUrl(url)

  urlByItemId.set(itemId, url)
  documentIdByItemId.set(itemId, documentId)
  itemIdByDocumentId.set(documentId, itemId)

  return {
    url,
    documentId,
  }
}

export function registerAutomergeItemIds(itemIds: string[]): void {
  for (const rawItemId of itemIds) {
    if (typeof rawItemId !== 'string') {
      continue
    }

    const itemId = rawItemId.trim()
    if (itemId.length === 0) {
      continue
    }

    ensureMapping(itemId)
  }
}

export function clearAutomergeItemIdMappings(): void {
  documentIdByItemId.clear()
  itemIdByDocumentId.clear()
  urlByItemId.clear()
}

export function toAutomergeUrlFromItemId(itemId: string): AnyDocumentId {
  return ensureMapping(itemId).url
}

export function toVaultItemIdFromAutomergeId(documentId: string): string {
  if (documentId.length === 0) {
    return documentId
  }

  let normalizedDocumentId = documentId

  if (documentId.startsWith(AUTOMERGE_URL_PREFIX)) {
    try {
      normalizedDocumentId = parseAutomergeUrl(documentId as AutomergeUrl).documentId
    } catch {
      normalizedDocumentId = documentId.slice(AUTOMERGE_URL_PREFIX.length)
    }
  }

  return itemIdByDocumentId.get(normalizedDocumentId)
    || itemIdByDocumentId.get(documentId)
    || normalizedDocumentId
}
