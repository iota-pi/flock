import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  queryKeys,
  queryClient,
  handleVaultError,
  clearQueryCache,
} from './client'
import store from '../store'
import { setUi } from '../state/ui'

// Mock state/ui action creator
vi.mock('../state/ui', () => ({
  setUi: vi.fn().mockReturnValue({ type: 'UI/Set' }),
}))

// Mock store dispatch
vi.mock('../store', () => ({
  default: {
    dispatch: vi.fn(),
  },
}))

// Mock console.error to avoid polluting output
describe('client.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('queryKeys', () => {
    it('should have correct keys', () => {
      expect(queryKeys.items).toEqual(['items'])
      expect(queryKeys.metadata).toEqual(['metadata'])
    })
  })

  describe('queryClient', () => {
    it('should be configured with default options', () => {
      const options = queryClient.getDefaultOptions()
      expect(options.queries?.staleTime).toBe(5 * 60 * 1000)
      expect(options.queries?.gcTime).toBe(24 * 60 * 60 * 1000)
      expect(options.queries?.retry).toBe(2)
      expect(options.queries?.refetchOnWindowFocus).toBe(true)
    })
  })

  describe('handleVaultError', () => {
    beforeEach(() => {
      vi.unstubAllEnvs()
    })

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('should start silently in test environment', () => {
      // Default is test, but explicit stub helps clarity
      vi.stubEnv('NODE_ENV', 'test')
      const err = new Error('test error')

      handleVaultError(err, 'Test failed')

      expect(store.dispatch).not.toHaveBeenCalled()
      expect(console.error).not.toHaveBeenCalled()
    })

    it('should dispatch UI error when not in test environment', () => {
      vi.stubEnv('NODE_ENV', 'development')
      const err = new Error('Real error')

      handleVaultError(err, 'Something went wrong')

      expect(store.dispatch).toHaveBeenCalledWith({ type: 'UI/Set' })
      expect(setUi).toHaveBeenCalledWith({
        message: {
          message: 'Something went wrong',
          severity: 'error',
        },
      })
    })
  })

  describe('clearQueryCache', () => {
    it('should clear the query client', () => {
      queryClient.setQueryData(queryKeys.items, ['data'])
      expect(queryClient.getQueryData(queryKeys.items)).toBeDefined()

      clearQueryCache()

      expect(queryClient.getQueryData(queryKeys.items)).toBeUndefined()
    })
  })
})
