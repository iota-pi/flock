import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('automergeRepoIds', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('correctly maps itemId to automerge URL and back', async () => {
    const { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } = await import('./automergeRepoIds')

    const itemId = 'test-item-123'
    const url = await toAutomergeUrlFromItemId(itemId)
    expect(url).toMatch(/^automerge:[a-zA-Z0-9]+$/)

    // Map it back from the full URL
    const resolvedFromUrl = toVaultItemIdFromAutomergeId(url)
    expect(resolvedFromUrl).toBe(itemId)

    // Map it back from just the document ID (extracted from URL)
    const documentId = url.replace('automerge:', '')
    const resolvedFromDocId = toVaultItemIdFromAutomergeId(documentId)
    expect(resolvedFromDocId).toBe(itemId)
  })

  it('generates consistent and stable mappings', async () => {
    const { toAutomergeUrlFromItemId } = await import('./automergeRepoIds')

    const itemId = 'my-stable-item-id'
    const url1 = await toAutomergeUrlFromItemId(itemId)
    const url2 = await toAutomergeUrlFromItemId(itemId)

    expect(url1).toBe(url2)
  })

  it('handles empty string documentId in toVaultItemIdFromAutomergeId', async () => {
    const { toVaultItemIdFromAutomergeId } = await import('./automergeRepoIds')
    expect(toVaultItemIdFromAutomergeId('')).toBe('')
  })

  it('falls back to normalized document ID if the ID is not in mapping cache', async () => {
    const { toVaultItemIdFromAutomergeId } = await import('./automergeRepoIds')
    
    // Normal document ID fallback
    expect(toVaultItemIdFromAutomergeId('unknown-id')).toBe('unknown-id')

    // URL fallback (it should extract the doc ID)
    expect(toVaultItemIdFromAutomergeId('automerge:fallback-id')).toBe('fallback-id')
    
    // Invalid URL structure fallback (e.g. failing parseAutomergeUrl)
    // If parseAutomergeUrl throws, normalizeDocumentId catches and slices AUTOMERGE_URL_PREFIX
    expect(toVaultItemIdFromAutomergeId('automerge:abc-xyz')).toBe('abc-xyz')
  })
})
