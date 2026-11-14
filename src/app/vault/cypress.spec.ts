import { DEPLOYMENTS } from '../../deployments'
import { allowsTestHooks } from './cypress'

describe('allowsTestHooks', () => {
  const production = Object.entries(DEPLOYMENTS)
    .filter(([, deployment]) => deployment?.environment === 'production')
    .map(([hostname]) => hostname)

  it('knows at least one production site', () => {
    expect(production.length).toBeGreaterThan(0)
  })

  it.each(production)('never turns on for %s, even under Cypress', hostname => {
    expect(allowsTestHooks(true, hostname)).toBe(false)
    expect(allowsTestHooks({}, hostname)).toBe(false)
  })

  it.each(['localhost', '127.0.0.1', 'flock-staging.cross-code.org'])('turns on under Cypress on %s', hostname => {
    expect(allowsTestHooks(true, hostname)).toBe(true)
    expect(allowsTestHooks({}, hostname)).toBe(true)
  })

  it('stays off without Cypress', () => {
    expect(allowsTestHooks(undefined, 'localhost')).toBe(false)
    expect(allowsTestHooks(false, 'flock-staging.cross-code.org')).toBe(false)
  })
})
