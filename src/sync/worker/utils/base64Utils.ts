export function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index])
    }

    return btoa(binary)
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  throw new Error('No base64 encoder available')
}

export function decodeBase64ToBytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const decoded = atob(value)
    const bytes = new Uint8Array(decoded.length)

    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index)
    }

    return bytes
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'))
  }

  throw new Error('No base64 decoder available')
}
