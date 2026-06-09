import type { DocHandle, DocumentId } from '@automerge/automerge-repo/slim'
import { ItemId } from 'src/shared/schemas/items'
import {
  readObjectSnapshot,
  toAutomergeUrlFromItemId,
  toVaultItemIdFromAutomergeId,
} from './automerge'

describe('automerge utils', () => {
  describe('readObjectSnapshot', () => {
    function createMockHandle(overrides: Record<string, any> = {}) {
      return {
        isReady: vi.fn().mockReturnValue(true),
        doc: vi.fn().mockReturnValue({ key: 'value' }),
        ...overrides,
      } as unknown as DocHandle<any>
    }

    it('returns null if isReady returns false', () => {
      const handle = createMockHandle({ isReady: () => false })
      expect(readObjectSnapshot(handle)).toBeNull()
    })

    it('returns null if handle.doc() throws an error', () => {
      const handle = createMockHandle({
        doc: vi.fn().mockImplementation(() => {
          throw new Error('doc reading fails')
        }),
      })
      expect(readObjectSnapshot(handle)).toBeNull()
    })

    it('returns null if doc is not a valid non-array object', () => {
      const handleWithArray = createMockHandle({ doc: () => [1, 2, 3] })
      expect(readObjectSnapshot(handleWithArray)).toBeNull()

      const handleWithNull = createMockHandle({ doc: () => null })
      expect(readObjectSnapshot(handleWithNull)).toBeNull()

      const handleWithString = createMockHandle({ doc: () => 'some string' })
      expect(readObjectSnapshot(handleWithString)).toBeNull()

      const handleWithNumber = createMockHandle({ doc: () => 123 })
      expect(readObjectSnapshot(handleWithNumber)).toBeNull()
    })

    it('returns the doc object if it is ready and valid', () => {
      const docObj = { id: 'item-1', name: 'Test' }
      const handle = createMockHandle({ doc: () => docObj })
      expect(readObjectSnapshot(handle)).toBe(docObj)
    })
  })

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
})
