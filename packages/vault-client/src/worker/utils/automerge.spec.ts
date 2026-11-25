import {
  type BinaryDocumentId,
  type DocHandle,
  type DocumentId,
  stringifyAutomergeUrl,
} from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '@vault/shared'
import {
  frontierOf,
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

    it('falls back to document ID when binary is not valid UTF-8 instead of returning replacement characters', async () => {
      const invalidUtf8Bytes = new Uint8Array([0xff, 0xfe, 0xfd]) as BinaryDocumentId
      const url = stringifyAutomergeUrl(invalidUtf8Bytes)
      const docId = url.replace(/^automerge:/, '') as DocumentId

      const result = toVaultItemIdFromAutomergeId(docId)
      expect(result).toBe(docId)
      expect(result).not.toContain('\uFFFD')
    })
  })

  describe('frontierOf', () => {
    /** A root change, then two branches from it on different actors, merged into one doc */
    function divergentHistories() {
      const root = Automerge.change(Automerge.init<Record<string, number>>({ actor: 'aa' }), doc => { doc.root = 1 })
      let left = Automerge.change(Automerge.clone(root), doc => { doc.left = 1 })
      const leftMid = Automerge.getHeads(left)
      left = Automerge.change(left, doc => { doc.left = 2 })
      const right = Automerge.change(Automerge.clone(root, { actor: 'bb' }), doc => { doc.right = 1 })
      const merged = Automerge.merge(Automerge.clone(left), right)
      return {
        merged,
        root: Automerge.getHeads(root),
        leftMid,
        left: Automerge.getHeads(left),
        right: Automerge.getHeads(right),
      }
    }

    it('keeps the heads of both branches', () => {
      const { merged, left, right } = divergentHistories()

      expect(frontierOf(merged, [...left, ...right]).sort()).toEqual([...left, ...right].sort())
      expect(frontierOf(merged, [...left, ...right]).sort()).toEqual(Automerge.getHeads(merged).sort())
    })

    it('drops heads that are ancestors of another, in either order', () => {
      const { merged, root, leftMid, left, right } = divergentHistories()

      expect(frontierOf(merged, [...root, ...left])).toEqual(left)
      expect(frontierOf(merged, [...left, ...leftMid, ...root])).toEqual(left)
      expect(frontierOf(merged, [...leftMid, ...right, ...left, ...root]).sort()).toEqual([...left, ...right].sort())
    })

    it('never claims more than it was given', () => {
      const { merged, leftMid, right } = divergentHistories()

      // The branch tip after leftMid is in the doc, but not in the set
      expect(frontierOf(merged, [...leftMid, ...right]).sort()).toEqual([...leftMid, ...right].sort())
    })

    it('drops duplicates and heads the doc lacks', () => {
      const { merged, left } = divergentHistories()
      const unknown = Automerge.getHeads(Automerge.change(Automerge.init<Record<string, number>>(), doc => { doc.x = 1 }))

      expect(frontierOf(merged, [...left, ...left, ...unknown])).toEqual(left)
      expect(frontierOf(merged, [])).toEqual([])
    })
  })
})
