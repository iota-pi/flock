import { getAppVersion } from './appVersion'

describe('getAppVersion', () => {
  it('shortens the release commit', () => {
    expect(getAppVersion('9c7ae1fc0123456789abcdef0123456789abcdef')).toBe('9c7ae1f')
  })

  it('names a build without a release', () => {
    expect(getAppVersion(undefined)).toBe('development')
    expect(getAppVersion('')).toBe('development')
  })
})
