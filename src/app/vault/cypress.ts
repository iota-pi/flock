import type { ApiHttpError } from '@vault/client'

/** Whether this page is running under Cypress, which gets the vault's test settings */
export const isCypress = typeof window !== 'undefined' && !!window.Cypress

/** Rethrows a failed request outside the promise chain, so Cypress fails the test on it */
export function failCypressTestOnRequestError(error: ApiHttpError): void {
  if (error.status === 401 || error.status === 403) return
  setTimeout(() => {
    throw error
  }, 0)
}
