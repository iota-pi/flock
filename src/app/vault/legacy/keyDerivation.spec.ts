import { decodeLegacySalt } from './keyDerivation'

describe('decodeLegacySalt', () => {
  it('uses the UTF-8 bytes of the stored string, not the bytes it encodes', () => {
    const salt = 'c2FsdA=='
    expect(new Uint8Array(decodeLegacySalt(salt))).toEqual(new TextEncoder().encode(salt))
  })
})
