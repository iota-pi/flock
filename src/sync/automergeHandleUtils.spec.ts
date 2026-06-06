import {
  findRepoDocHandle,
  tryResolveNonReadyHandle,
  awaitHandleReadyIfNeeded,
  readReadyObjectSnapshot,
} from './automergeHandleUtils'
import type { DocHandle } from '@automerge/automerge-repo/slim'
import { AutomergeUrl, generateAutomergeUrl, interpretAsDocumentId } from '@automerge/automerge-repo/slim'

describe('automergeHandleUtils', () => {
  function createMockHandle(overrides: Record<string, any> = {}) {
    return {
      isReady: vi.fn().mockReturnValue(true),
      isUnavailable: vi.fn().mockReturnValue(false),
      doneLoading: vi.fn(),
      whenReady: vi.fn().mockResolvedValue(undefined),
      doc: vi.fn().mockReturnValue({ key: 'value' }),
      ...overrides,
    } as unknown as DocHandle<any>
  }

  describe('findRepoDocHandle', () => {
    it('returns the handle if already in handles cache', () => {
      const mockHandle = createMockHandle()
      const url = generateAutomergeUrl()
      const documentId = interpretAsDocumentId(url)
      const mockRepo = {
        handles: {
          [documentId]: mockHandle,
        },
        find: vi.fn(),
      }

      const result = findRepoDocHandle(mockRepo as any, url)
      expect(result).toBe(mockHandle)
      expect(mockRepo.find).not.toHaveBeenCalled()
    })

    it('triggers repo.find and returns the handle if not in handles cache', () => {
      const mockHandle = createMockHandle()
      const url = generateAutomergeUrl()
      const documentId = interpretAsDocumentId(url)
      const mockRepo = {
        handles: {} as Record<string, any>,
        find: vi.fn().mockImplementation((targetUrl) => {
          mockRepo.handles[documentId] = mockHandle
          return Promise.resolve(mockHandle)
        }),
      }

      const result = findRepoDocHandle(mockRepo as any, url)
      expect(result).toBe(mockHandle)
      expect(mockRepo.find).toHaveBeenCalledWith(url)
    })

    it('returns undefined if interpretAsDocumentId or find throws', () => {
      const mockRepo = {
        handles: {},
        find: vi.fn().mockImplementation(() => {
          throw new Error('Repo error')
        }),
      }

      // Invalid Automerge URL will cause interpretAsDocumentId to throw
      const resultInvalid = findRepoDocHandle(mockRepo as any, 'invalid-url' as AutomergeUrl)
      expect(resultInvalid).toBeUndefined()
    })
  })

  describe('tryResolveNonReadyHandle', () => {
    it('does nothing if handle is undefined', () => {
      expect(() => tryResolveNonReadyHandle(undefined)).not.toThrow()
    })

    it('does nothing if handle is already ready or unavailable', () => {
      const handleReady = createMockHandle({ isReady: () => true })
      tryResolveNonReadyHandle(handleReady)
      expect(handleReady.doneLoading).not.toHaveBeenCalled()

      const handleUnavailable = createMockHandle({ isReady: () => false, isUnavailable: () => true })
      tryResolveNonReadyHandle(handleUnavailable)
      expect(handleUnavailable.doneLoading).not.toHaveBeenCalled()
    })

    it('calls doneLoading if handle is neither ready nor unavailable', () => {
      const handle = createMockHandle({ isReady: () => false, isUnavailable: () => false })
      tryResolveNonReadyHandle(handle)
      expect((handle as any).doneLoading).toHaveBeenCalled()
    })

    it('swallows errors thrown by doneLoading', () => {
      const handle = createMockHandle({
        isReady: () => false,
        isUnavailable: () => false,
        doneLoading: vi.fn().mockImplementation(() => {
          throw new Error('doneLoading fails')
        }),
      })

      expect(() => tryResolveNonReadyHandle(handle)).not.toThrow()
      expect((handle as any).doneLoading).toHaveBeenCalled()
    })
  })

  describe('awaitHandleReadyIfNeeded', () => {
    it('resolves immediately if handle is undefined', async () => {
      await expect(awaitHandleReadyIfNeeded(undefined)).resolves.toBeUndefined()
    })

    it('resolves immediately if handle is ready or unavailable', async () => {
      const handleReady = createMockHandle({ isReady: () => true })
      await awaitHandleReadyIfNeeded(handleReady)
      expect(handleReady.whenReady).not.toHaveBeenCalled()

      const handleUnavailable = createMockHandle({ isReady: () => false, isUnavailable: () => true })
      await awaitHandleReadyIfNeeded(handleUnavailable)
      expect(handleUnavailable.whenReady).not.toHaveBeenCalled()
    })

    it('awaits whenReady if handle is neither ready nor unavailable', async () => {
      const handle = createMockHandle({ isReady: () => false, isUnavailable: () => false })
      await awaitHandleReadyIfNeeded(handle)
      expect(handle.whenReady).toHaveBeenCalledWith(['ready', 'unavailable'])
    })
  })

  describe('readReadyObjectSnapshot', () => {
    it('returns null if handle is undefined or unavailable', () => {
      expect(readReadyObjectSnapshot(undefined)).toBeNull()

      const handleUnavailable = createMockHandle({ isUnavailable: () => true })
      expect(readReadyObjectSnapshot(handleUnavailable)).toBeNull()
    })

    it('resolves pending handles if resolvePending is true', () => {
      const handle = createMockHandle({
        isReady: vi.fn().mockReturnValue(false),
        isUnavailable: () => false,
      })

      // Initially it's not ready, calling readReadyObjectSnapshot with resolvePending will try to resolve it
      const result = readReadyObjectSnapshot(handle, { resolvePending: true })
      expect((handle as any).doneLoading).toHaveBeenCalled()
      expect(result).toBeNull() // Still returns null since isReady() returned false in our mocks
    })

    it('returns null if isReady remains false or isUnavailable returns true', () => {
      const handle = createMockHandle({ isReady: () => false })
      expect(readReadyObjectSnapshot(handle)).toBeNull()
    })

    it('returns null if handle.doc() throws an error', () => {
      const handle = createMockHandle({
        doc: vi.fn().mockImplementation(() => {
          throw new Error('doc reading fails')
        }),
      })
      expect(readReadyObjectSnapshot(handle)).toBeNull()
    })

    it('returns null if doc is not a valid non-array object', () => {
      const handleWithArray = createMockHandle({ doc: () => [1, 2, 3] })
      expect(readReadyObjectSnapshot(handleWithArray)).toBeNull()

      const handleWithNull = createMockHandle({ doc: () => null })
      expect(readReadyObjectSnapshot(handleWithNull)).toBeNull()

      const handleWithString = createMockHandle({ doc: () => 'some string' })
      expect(readReadyObjectSnapshot(handleWithString)).toBeNull()

      const handleWithNumber = createMockHandle({ doc: () => 123 })
      expect(readReadyObjectSnapshot(handleWithNumber)).toBeNull()
    })

    it('returns the doc object if it is ready and valid', () => {
      const docObj = { id: 'item-1', name: 'Test' }
      const handle = createMockHandle({ doc: () => docObj })
      expect(readReadyObjectSnapshot(handle)).toBe(docObj)
    })
  })
})
