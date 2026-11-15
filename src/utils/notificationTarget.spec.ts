import { getNotificationTarget } from './notificationTarget'

const origin = 'https://flock.example'

describe('getNotificationTarget', () => {
  it('keeps paths on this origin', () => {
    expect(getNotificationTarget('/', origin)).toBe('/')
    expect(getNotificationTarget('/people?id=1#notes', origin)).toBe('/people?id=1#notes')
  })

  it('opens the home page for anything else', () => {
    expect(getNotificationTarget(undefined, origin)).toBe('/')
    expect(getNotificationTarget(42, origin)).toBe('/')
    expect(getNotificationTarget('', origin)).toBe('/')
    expect(getNotificationTarget('https://elsewhere.example/login', origin)).toBe('/')
    expect(getNotificationTarget('https://flock.example/people', origin)).toBe('/')
    expect(getNotificationTarget('//elsewhere.example/login', origin)).toBe('/')
    expect(getNotificationTarget('/\\elsewhere.example/login', origin)).toBe('/')
    expect(getNotificationTarget('javascript:alert(1)', origin)).toBe('/')
    expect(getNotificationTarget('people', origin)).toBe('/')
  })

  it('never opens the migration app', () => {
    expect(getNotificationTarget('/migrate/', origin)).toBe('/')
    expect(getNotificationTarget('/migrate', origin)).toBe('/')
    expect(getNotificationTarget('/migrated-notes', origin)).toBe('/migrated-notes')
  })
})
