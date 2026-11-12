import { MAX_LOGIN_DEVICES } from '@vault/shared'
import { isLoginDevice, normalizeLoginDevices, withLoginDevice, withoutLoginDevice } from './loginDevices'

describe('login devices', () => {
  it('keeps only strings from a stored list', () => {
    expect(normalizeLoginDevices(['a', 1, null, 'b'])).toEqual(['a', 'b'])
    expect(normalizeLoginDevices(undefined)).toEqual([])
    expect(normalizeLoginDevices('a')).toEqual([])
  })

  it('knows a device only by a hash in the list', () => {
    expect(isLoginDevice({ loginDevices: ['a', 'b'] }, 'b')).toBe(true)
    expect(isLoginDevice({ loginDevices: ['a', 'b'] }, 'c')).toBe(false)
    expect(isLoginDevice({ loginDevices: ['a'] }, undefined)).toBe(false)
    expect(isLoginDevice({}, 'a')).toBe(false)
  })

  it('adds a new device at the end and leaves a known one where it is', () => {
    expect(withLoginDevice(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(withLoginDevice(['a', 'b'], 'a')).toBeUndefined()
  })

  it('forgets the earliest device when the list is full', () => {
    const full = Array.from({ length: MAX_LOGIN_DEVICES }, (_, i) => `device-${i}`)
    expect(withLoginDevice(full, 'new')).toEqual([...full.slice(1), 'new'])
  })

  it('removes a device it has, and reports one it does not', () => {
    expect(withoutLoginDevice(['a', 'b'], 'a')).toEqual(['b'])
    expect(withoutLoginDevice(['a', 'b'], 'c')).toBeUndefined()
  })
})
