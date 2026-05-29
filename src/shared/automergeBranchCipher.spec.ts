import {
  decodeEncryptedAutomergeDoc,
  encodeEncryptedAutomergeDoc,
} from './automergeBranchCipher'


function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

describe('automergeBranchCipher', () => {
  it('round-trips hex-encoded automerge branch payloads', () => {
    const iv = new Uint8Array(16)
    const cipher = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

    for (let index = 0; index < iv.length; index += 1) {
      iv[index] = index
    }

    const encoded = encodeEncryptedAutomergeDoc({ iv, cipher })
    const decoded = decodeEncryptedAutomergeDoc(encoded)

    expect(Array.from(decoded.iv)).toEqual(Array.from(iv))
    expect(Array.from(decoded.cipher)).toEqual(Array.from(cipher))
  })

  it('decodes legacy base64-concatenated payloads', () => {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const cipher = crypto.getRandomValues(new Uint8Array(64))

    const encoded = `${toBase64(iv)}${toBase64(cipher)}`
    const decoded = decodeEncryptedAutomergeDoc(encoded)

    expect(Array.from(decoded.iv)).toEqual(Array.from(iv))
    expect(Array.from(decoded.cipher)).toEqual(Array.from(cipher))
  })
})
