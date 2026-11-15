/**
 * Checks that the deployed site really serves the CSP and HSTS headers in public/_headers. The unit
 * tests only read the file, so a deploy that stopped shipping it (or a host that ignored it) would
 * otherwise go unnoticed. The Vite dev server doesn't serve _headers, so this only runs over HTTPS,
 * which in CI means staging.
 *
 * The deploy sets each site's own connect-src (withConnectSources in src/deployments.ts), so the
 * file is rewritten the same way for the site under test before comparing.
 */
import { DEPLOYMENTS, withConnectSources } from '../../src/deployments'

const CHECKED_HEADERS = [
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
]

/** Pages and files the headers must cover: the app, the migration app, its service worker and a deep link */
const PATHS = ['/', '/migrate/', '/service-worker.js', '/manifest.webmanifest', '/people']

/** The headers public/_headers sets for every path (its `/*` block), keyed by lower-case name */
function headersForEveryPath(file: string): Record<string, string> {
  const headers: Record<string, string> = {}
  let inBlock = false
  for (const line of file.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      inBlock = line.trim() === '/*'
      continue
    }
    const match = inBlock ? line.trim().match(/^([\w-]+):\s*(.*)$/) : null
    if (match) headers[match[1].toLowerCase()] = match[2]
  }
  return headers
}

describe('Security headers', () => {
  before(function () {
    if (!Cypress.config('baseUrl')?.startsWith('https://')) this.skip()
  })

  it('serves the CSP and HSTS headers from public/_headers on every path', () => {
    cy.readFile('public/_headers').then((file: string) => {
      const hostname = new URL(Cypress.config('baseUrl')!).hostname
      const deployment = DEPLOYMENTS[hostname]
      if (!deployment) throw new Error(`src/deployments.ts has no deployment for ${hostname}`)
      const expected = headersForEveryPath(withConnectSources(file, deployment))
      for (const name of CHECKED_HEADERS) {
        expect(expected, `public/_headers sets ${name}`).to.have.property(name.toLowerCase())
      }

      for (const path of PATHS) {
        cy.request(path).then(response => {
          for (const name of CHECKED_HEADERS) {
            const key = name.toLowerCase()
            expect(response.headers[key], `${name} on ${path}`).to.equal(expected[key])
          }
        })
      }
    })
  })
})
