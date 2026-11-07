import { DEPLOYMENTS } from './deployments'

/** A deployed site's settings, or the ones Vite was given when running anywhere else */
export function resolveEnv(hostname: string | undefined) {
  const deployment = hostname ? DEPLOYMENTS[hostname] : undefined
  return {
    ENVIRONMENT: deployment?.environment ?? import.meta.env.MODE,
    SENTRY_DSN: deployment?.sentryDsn,
    VAPID_PUBLIC_KEY: deployment?.vapidPublicKey ?? (import.meta.env.VITE_VAPID_PUBLIC_KEY || ''),
    VAULT_ENDPOINT: deployment?.vaultEndpoint ?? (import.meta.env.VITE_VAULT_ENDPOINT || '').replace(/\/$/, ''),
  }
}

export default resolveEnv(globalThis.location?.hostname)
