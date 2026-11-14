import { DEPLOYMENTS } from './deployments'
import type * as EnvModule from './env'

// setupTests mocks this module for every other spec
const { resolveEnv } = await vi.importActual<typeof EnvModule>('./env')

describe('resolveEnv', () => {
  it('uses the settings of a deployed site', () => {
    const production = DEPLOYMENTS['flock.cross-code.org']
    expect(resolveEnv('flock.cross-code.org')).toEqual({
      ENVIRONMENT: 'production',
      SENTRY_DSN: production?.sentryDsn,
      VAPID_PUBLIC_KEY: production?.vapidPublicKey,
      VAULT_ENDPOINT: production?.vaultEndpoint,
    })
  })

  it('keeps staging away from the production API, Sentry project and VAPID key', () => {
    const staging = resolveEnv('flock-staging.cross-code.org')
    expect(staging.ENVIRONMENT).toBe('staging')
    expect(staging.SENTRY_DSN).toBeUndefined()
    expect(staging.VAULT_ENDPOINT).not.toBe(DEPLOYMENTS['flock.cross-code.org']?.vaultEndpoint)
    // Not the build's key either: staging sends no reminders, so the app mustn't offer them
    expect(staging.VAPID_PUBLIC_KEY).toBe('')
  })

  it.each(['localhost', 'flock-other.cross-code.org', undefined])('falls back to the build settings on %s', hostname => {
    const env = resolveEnv(hostname)
    expect(env.SENTRY_DSN).toBeUndefined()
    expect(env.ENVIRONMENT).toBe(import.meta.env.MODE)
  })
})
