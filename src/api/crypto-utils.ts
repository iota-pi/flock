export function fromBytes(array: ArrayBuffer): string {
  const byteArray = Array.from(new Uint8Array(array))
  const asString = byteArray.map(b => String.fromCharCode(b)).join('')
  return btoa(asString)
}

export function fromBytesUrlSafe(array: ArrayBuffer): string {
  return fromBytes(array).replace(/\//g, '_').replace(/\+/g, '-')
}

export function toBytes(str: string): ArrayBuffer {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))).buffer
}

export function getSalt() {
  const saltArray = new Uint8Array(16)
  crypto.getRandomValues(saltArray)
  return fromBytes(saltArray.buffer)
}
