import { errorMessage } from './errorMessage'

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type')
  })

  it('stringifies anything else', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage({ message: 'not an Error' })).toBe('[object Object]')
  })
})
