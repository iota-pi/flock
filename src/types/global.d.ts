
import type * as vault from '../api/vault'
import type * as mutations from '../api/localFirstItemMutations'
import type { hasApiAuthToken } from '../api/runtime'

// Expose store for Cypress in a typed way
declare global {
  interface Window {
    Cypress?: boolean | Record<string, unknown>
    vault?: Promise<typeof vault>
    mutations?: Promise<typeof mutations>
    hasApiAuthToken?: typeof hasApiAuthToken
    invalidateQuery?: (key: 'items' | 'metadata') => Promise<void>
  }
}

export {}
