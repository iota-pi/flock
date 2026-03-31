
import type * as vault from '../api/vault'
import type * as mutations from '../api/mutations'
import type { hasApiAuthToken } from '../api/runtime'
import type { queryKeys } from '../api/queryClient'

// Expose store for Cypress in a typed way
declare global {
  interface Window {
    Cypress?: boolean | Record<string, unknown>
    vault?: Promise<typeof vault>
    mutations?: Promise<typeof mutations>
    hasApiAuthToken?: typeof hasApiAuthToken
    invalidateQuery?: (key: keyof typeof queryKeys) => Promise<void>
    queryKeys?: typeof queryKeys
  }
}

export {}
