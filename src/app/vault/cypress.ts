import type { ApiHttpError } from '@vault/client'
import { DEPLOYMENTS } from '../../deployments'

/**
 * Whether a page may turn on the test hooks: weak key derivation and the vault on `window`.
 * Production never does, whatever `window.Cypress` says, so script that sets the flag there
 * can't make the credentials written next weak for good.
 */
export function allowsTestHooks(cypress: unknown, hostname: string): boolean {
  return !!cypress && DEPLOYMENTS[hostname]?.environment !== 'production'
}

/** Whether this page is running under Cypress, which gets the vault's test settings */
export const isCypress = typeof window !== 'undefined' && allowsTestHooks(window.Cypress, window.location.hostname)

/** Rethrows a failed request outside the promise chain, so Cypress fails the test on it */
export function failCypressTestOnRequestError(error: ApiHttpError): void {
  if (error.status === 401 || error.status === 403) return
  setTimeout(() => {
    throw error
  }, 0)
}
