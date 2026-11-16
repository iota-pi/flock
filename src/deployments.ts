export type Deployment = {
  environment: string,
  sentryDsn?: string,
  /** Without one, the stage sends no reminders and the app doesn't offer them (sst.config.ts) */
  vapidPublicKey?: string,
  vaultEndpoint: string,
}

/**
 * The settings of each deployed site, by hostname. One build serves every stage, so what Cypress
 * tests on staging is what reaches production, and the app picks its settings when it loads.
 *
 * Everything here is public: the sites serve it to anyone. `sst.config.ts` refuses to deploy a site
 * whose settings don't match its real API and VAPID key.
 */
export const DEPLOYMENTS: Partial<Record<string, Deployment>> = {
  'flock.cross-code.org': {
    environment: 'production',
    sentryDsn: 'https://9165ee7e30058dda2ee3529b97cf1ae3@o4511115810832384.ingest.us.sentry.io/4511115818762240',
    vapidPublicKey: 'BFOkKeQTO1JoCY2sUhwQ0WEpkvM7SLcc0jSqIUE7mPr6i6aLJRCW0IWxSSkcVCOvonPnNR-bl6JN-c1vK8qpk9A',
    vaultEndpoint: 'https://api.flock.cross-code.org',
  },
  // Sends no reminders, so it holds no VAPID private key (production's must stay out of it)
  'flock-staging.cross-code.org': {
    environment: 'staging',
    vaultEndpoint: 'https://api.flock-staging.cross-code.org',
  },
}

/** What a deployment's pages may connect to: their own site, their API and their Sentry project */
export function connectSources(deployment: Deployment): string[] {
  const origins = [deployment.vaultEndpoint, deployment.sentryDsn]
    .filter((url): url is string => Boolean(url))
    .map(url => new URL(url).origin)
  return ["'self'", ...origins]
}

const CONNECT_SRC = /^(\s*Content-Security-Policy(?:-Report-Only)?:(?:[^;\r\n]*;)*?\s*)connect-src\b[^;\r\n]*/gm

/**
 * Sets the `connect-src` of every CSP in a `_headers` file to the deployment's sources, leaving the
 * rest alone. public/_headers lists production's, and since every stage ships the same build, the
 * deploy (sst.config.ts) narrows it to the stage's own, so no site may reach another stage's API.
 * Running it again gives the same file, so a build can be deployed more than once.
 */
export function withConnectSources(headers: string, deployment: Deployment): string {
  let rewritten = 0
  const result = headers.replace(CONNECT_SRC, (_, prefix: string) => {
    rewritten += 1
    return `${prefix}connect-src ${connectSources(deployment).join(' ')}`
  })
  if (rewritten === 0) {
    throw new Error('_headers has no CSP with a connect-src to set')
  }
  return result
}
