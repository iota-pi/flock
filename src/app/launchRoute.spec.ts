import { getLaunchRoute } from './launchRoute'

describe('getLaunchRoute', () => {
  const current = { origin: 'https://flock.example', pathname: '/prayer', search: '', hash: '' }

  it('routes to the page the app was launched with', () => {
    expect(getLaunchRoute('https://flock.example/people?id=1#notes', current)).toBe('/people?id=1#notes')
  })

  it('stays put for the page already showing', () => {
    expect(getLaunchRoute('https://flock.example/prayer', current)).toBeNull()
  })

  it('ignores missing, other-site and migration app URLs', () => {
    expect(getLaunchRoute(undefined, current)).toBeNull()
    expect(getLaunchRoute('https://elsewhere.example/people', current)).toBeNull()
    expect(getLaunchRoute('https://flock.example/migrate/', current)).toBeNull()
  })
})
