import { decodeLegacySalt, deriveLegacyKey } from './keyDerivation'

describe('decodeLegacySalt', () => {
  it('uses the UTF-8 bytes of the stored string, not the bytes it encodes', () => {
    const salt = 'c2FsdA=='
    expect(new Uint8Array(decodeLegacySalt(salt))).toEqual(new TextEncoder().encode(salt))
  })
})

describe('deriveLegacyKey', () => {
  it('derives 32 bytes with PBKDF2-HMAC-SHA256', async () => {
    // A published PBKDF2-HMAC-SHA256 test vector: "password", salt "salt", 1 iteration
    const key = await deriveLegacyKey({
      password: 'password',
      salt: new TextEncoder().encode('salt').buffer,
      iterations: 1,
    })

    expect(Buffer.from(key).toString('hex'))
      .toBe('120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b')
  })
})
