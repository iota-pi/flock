import type { DocumentId } from '@automerge/automerge-repo/slim'

import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { ItemId } from 'src/shared/schemas/items'


describe('automergeRepoIds', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('correctly maps itemId to documentId and back', async () => {
    const itemId = 'test-item-123' as ItemId
    const url = toAutomergeUrlFromItemId(itemId)
    expect(url).toMatch(/^automerge:[a-zA-Z0-9]+$/)

    const documentId = url.replace('automerge:', '') as DocumentId
    const resolvedFromDocId = toVaultItemIdFromAutomergeId(documentId)
    expect(resolvedFromDocId).toBe(itemId)
  })

  it('generates consistent and stable mappings', async () => {
    const itemId = 'my-stable-item-id' as ItemId
    const url1 = toAutomergeUrlFromItemId(itemId)
    const url2 = toAutomergeUrlFromItemId(itemId)

    expect(url1).toBe(url2)
  })

  it('handles empty string documentId in toVaultItemIdFromAutomergeId', async () => {
    expect(toVaultItemIdFromAutomergeId('' as DocumentId)).toBe('')
  })

  it('falls back to normalized document ID if the ID is not in mapping cache', async () => {
    expect(toVaultItemIdFromAutomergeId('unknown-id' as DocumentId)).toBe('unknown-id')

    expect(toVaultItemIdFromAutomergeId('abc-xyz' as DocumentId)).toBe('abc-xyz')
  })
})
