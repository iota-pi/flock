import { readFileSync } from 'node:fs'
import { DEPLOYMENTS } from './deployments'

const CSP_HEADERS = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']

/** The `connect-src` sources of each CSP in public/_headers */
function connectSources(): string[][] {
  // Vitest runs from the project root
  const headers = readFileSync('public/_headers', 'utf8')
  return headers.split(/\r?\n/)
    .map(line => line.trim().match(/^([\w-]+):\s*(.*)$/))
    .filter(match => match !== null && CSP_HEADERS.includes(match[1]))
    .map(match => {
      const directive = match![2].split(';').map(part => part.trim().split(/\s+/))
        .find(([name]) => name === 'connect-src')
      return directive?.slice(1) ?? []
    })
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
