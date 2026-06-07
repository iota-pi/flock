import {
  readObjectSnapshot,
} from './automergeHandleUtils'
import type { DocHandle } from '@automerge/automerge-repo/slim'

describe('automergeHandleUtils', () => {
  function createMockHandle(overrides: Record<string, any> = {}) {
    return {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ key: 'value' }),
      ...overrides,
    } as unknown as DocHandle<any>
  }

  describe('readObjectSnapshot', () => {
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
})
