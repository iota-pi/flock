
import type * as vault from '../api/Vault'
import type * as mutations from '../api/mutations'
import type { checkAxios } from '../api/axios'
import type { queryKeys } from '../api/client'

// Expose store for Cypress in a typed way
declare global {
  interface Window {
    Cypress?: boolean | Record<string, unknown>
    vault?: Promise<typeof vault>
    mutations?: Promise<typeof mutations>
    checkAxios?: typeof checkAxios
    invalidateQuery?: (key: keyof typeof queryKeys) => Promise<void>
    queryKeys?: typeof queryKeys
  }
}

export {}
