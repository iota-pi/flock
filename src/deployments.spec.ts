import { readFileSync } from 'node:fs'
import { DEPLOYMENTS } from './deployments'

const CSP_HEADERS = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']

/**
 * The `connect-src` sources of each CSP in public/_headers that limits connections. A policy with
 * neither `connect-src` nor `default-src` (such as the Trusted Types one) doesn't, so it's skipped.
 */
function connectSources(): string[][] {
  // Vitest runs from the project root
  const headers = readFileSync('public/_headers', 'utf8')
  return headers.split(/\r?\n/)
    .map(line => line.trim().match(/^([\w-]+):\s*(.*)$/))
    .filter(match => match !== null && CSP_HEADERS.includes(match[1]))
    .map(match => match![2].split(';').map(part => part.trim().split(/\s+/)))
    .filter(directives => directives.some(([name]) => name === 'connect-src' || name === 'default-src'))
    .map(directives => directives.find(([name]) => name === 'connect-src')?.slice(1) ?? [])
}

describe('deployments', () => {
  it('lets every deployed site reach its API and Sentry under the CSP', () => {
    const policies = connectSources()
    expect(policies.length).toBeGreaterThan(0)

    for (const deployment of Object.values(DEPLOYMENTS)) {
      const origins = [deployment!.vaultEndpoint, deployment!.sentryDsn].filter(Boolean)
        .map(url => new URL(url!).origin)
      for (const sources of policies) {
        expect(sources).toEqual(expect.arrayContaining(origins))
      }
    }
  })
})
