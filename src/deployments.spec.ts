import { readFileSync } from 'node:fs'
import { DEPLOYMENTS, connectSources, withConnectSources } from './deployments'

const CSP_HEADERS = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']

/** public/_headers as the build ships it. Vitest runs from the project root. */
function builtHeaders(): string {
  return readFileSync('public/_headers', 'utf8')
}

/**
 * The `connect-src` sources of each CSP in a `_headers` file that limits connections. A policy with
 * neither `connect-src` nor `default-src` (such as the Trusted Types one) doesn't, so it's skipped.
 */
function policySources(headers: string): string[][] {
  return headers.split(/\r?\n/)
    .map(line => line.trim().match(/^([\w-]+):\s*(.*)$/))
    .filter(match => match !== null && CSP_HEADERS.includes(match[1]))
    .map(match => match![2].split(';').map(part => part.trim().split(/\s+/)))
    .filter(directives => directives.some(([name]) => name === 'connect-src' || name === 'default-src'))
    .map(directives => directives.find(([name]) => name === 'connect-src')?.slice(1) ?? [])
}

const production = DEPLOYMENTS['flock.cross-code.org']!
const staging = DEPLOYMENTS['flock-staging.cross-code.org']!

describe('deployments', () => {
  it('lets each deployed site reach only its own API and Sentry under the CSP', () => {
    for (const deployment of Object.values(DEPLOYMENTS)) {
      const origins = [deployment!.vaultEndpoint, deployment!.sentryDsn].filter(Boolean)
        .map(url => new URL(url!).origin)
      const policies = policySources(withConnectSources(builtHeaders(), deployment!))
      expect(policies.length).toBeGreaterThan(0)
      for (const sources of policies) {
        expect(sources).toEqual(["'self'", ...origins])
      }
    }
  })

  it("keeps staging's API out of production's CSP", () => {
    for (const sources of policySources(withConnectSources(builtHeaders(), production))) {
      expect(sources).not.toContain(new URL(staging.vaultEndpoint).origin)
    }
  })

  it("ships production's sources, so production's deploy leaves the file as it is", () => {
    expect(withConnectSources(builtHeaders(), production)).toBe(builtHeaders())
  })

  it('changes nothing but connect-src, and gives the same file when run again', () => {
    const forStaging = withConnectSources(builtHeaders(), staging)
    expect(forStaging).not.toBe(builtHeaders())
    expect(withConnectSources(forStaging, staging)).toBe(forStaging)
    expect(withConnectSources(forStaging, production)).toBe(builtHeaders())
  })

  it('leaves out Sentry for a deployment without it', () => {
    expect(connectSources(staging)).toEqual(["'self'", 'https://api.flock-staging.cross-code.org'])
  })

  it('throws for headers with no connect-src to set', () => {
    expect(() => withConnectSources('/*\n  X-Frame-Options: DENY\n', staging)).toThrow()
  })
})
