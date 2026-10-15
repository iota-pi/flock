
import type * as vault from '@vault/client'
import type * as mutations from '../features/items/mutations/itemMutations'
import type { hasApiAuthToken } from '@vault/client/runtime'
import { SyncBridge } from 'src/app/vault/syncBridge'

// Expose store for Cypress in a typed way
declare global {
  interface Window {
    Cypress?: boolean | Record<string, unknown>
    vault?: Promise<typeof vault>
    mutations?: Promise<typeof mutations>
    syncBridge?: Promise<typeof SyncBridge>
    hasApiAuthToken?: typeof hasApiAuthToken
  }
}

export {}
