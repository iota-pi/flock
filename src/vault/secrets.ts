import { Resource } from 'sst'

/** The SST secrets the server's functions are linked to (sst.config.ts) */
export type SecretName = 'UNKNOWN_ACCOUNT_SECRET' | 'VAPID_SUBJECT' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'

/**
 * Reads a linked SST secret. SST encrypts linked values into the function's bundle, so secrets don't
 * sit in plaintext Lambda environment variables. Returns undefined where the secret isn't linked,
 * such as on a local server, rather than throwing like `Resource` does.
 */
export function readSecret(name: SecretName): string | undefined {
  const resources = Resource as unknown as Record<string, { value?: unknown } | undefined>
  if (!(name in resources)) return undefined
  const value = resources[name]?.value
  return typeof value === 'string' && value ? value : undefined
}
