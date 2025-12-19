import type store from '../store'
import type * as vault from '../api/Vault'
import type { checkAxios } from '../api/axios'

// Expose store for Cypress in a typed way
declare global {
  interface Window {
    Cypress?: boolean | Record<string, unknown>
    vault?: Promise<typeof vault>
    checkAxios?: typeof checkAxios
  }
}

export {}
