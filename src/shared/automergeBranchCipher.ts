type DecodedAutomergeBranch = {
  iv: Uint8Array
  cipher: Uint8Array
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < hex.length; index += 2) {
    const val = parseInt(hex.slice(index, index + 2), 16)
    if (Number.isNaN(val)) {
      throw new Error('Invalid hex')
    }
    bytes[index / 2] = val
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  const hex = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    hex[i] = bytes[i].toString(16).padStart(2, '0')
  }
  return hex.join('')
}

function decodeBase64ToBytes(base64Value: string): Uint8Array | null {
  if (!base64Value) {
    return null
  }

  try {
    const binary = atob(base64Value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

export function encodeEncryptedAutomergeDoc(input: {
  iv: Uint8Array
  cipher: Uint8Array | ArrayBuffer
}): string {
  const normalizedCipher = input.cipher instanceof Uint8Array
    ? input.cipher
    : new Uint8Array(input.cipher)

  return `${bytesToHex(input.iv)}${bytesToHex(normalizedCipher)}`
}

export function decodeEncryptedAutomergeDoc(encryptedDoc: string): DecodedAutomergeBranch {
  if (typeof encryptedDoc !== 'string' || encryptedDoc.length === 0) {
    throw new Error('Encrypted Automerge payload is empty')
  }

  // Current format: ivHex(16 bytes -> 32 chars) + cipherHex
  if (encryptedDoc.length > 32) {
    try {
      const ivHex = encryptedDoc.slice(0, 32)
      const cipherHex = encryptedDoc.slice(32)
      const iv = hexToBytes(ivHex)
      const cipher = hexToBytes(cipherHex)
      if (iv.byteLength === 16 && cipher.byteLength > 0) {
        return { iv, cipher }
      }
    } catch (_) {
      // Fallback to legacy base64 format on invalid hex error
    }
  }

  // Legacy format: base64(iv) + base64(cipher) with iv encoded from 16 bytes (24 chars).
  if (encryptedDoc.length > 24) {
    const ivBase64 = encryptedDoc.slice(0, 24)
    const cipherBase64 = encryptedDoc.slice(24)
    const iv = decodeBase64ToBytes(ivBase64)
    const cipher = decodeBase64ToBytes(cipherBase64)
    if (iv && cipher && iv.byteLength === 16 && cipher.byteLength > 0) {
      return { iv, cipher }
    }
  }

  throw new Error('Unsupported encrypted Automerge payload encoding')
}