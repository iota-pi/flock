export function bufferToBase64(buf: ArrayBuffer): string {
  return new Uint8Array(buf).toBase64()
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  return Uint8Array.fromBase64(base64).buffer
}

export async function isWebAuthnPrfSupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    return false
  }

  try {
    const isUvpaa = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    if (!isUvpaa) return false

    // Check PRF extension support if method exists
    if (typeof window.PublicKeyCredential.getClientCapabilities === 'function') {
      const caps = await window.PublicKeyCredential.getClientCapabilities()
      if (caps && 'prf' in caps) {
        return Boolean(caps.prf)
      }
    }
    return true
  } catch {
    return false
  }
}

export type RegisterPrfResult = {
  credentialId: string
  prfSalt: string
  prfOutput: ArrayBuffer
}

export async function registerPrfCredential(account: string): Promise<RegisterPrfResult> {
  if (!window.PublicKeyCredential) {
    throw new Error('WebAuthn is not supported on this browser')
  }

  const saltBytes = new Uint8Array(32)
  crypto.getRandomValues(saltBytes)

  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)

  const userId = new TextEncoder().encode(account)

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: 'Flock',
        id: window.location.hostname,
      },
      user: {
        id: userId,
        name: account,
        displayName: account,
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' }, // ES256
        { alg: -257, type: 'public-key' }, // RS256
      ],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'preferred',
      },
      extensions: {
        prf: {
          eval: {
            first: saltBytes.buffer,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Failed to create biometric credential')
  }

  const clientExtensionResults = credential.getClientExtensionResults() as {
    prf?: {
      enabled?: boolean
      results?: {
        first?: ArrayBuffer
      }
    }
  }

  const prfOutput = clientExtensionResults?.prf?.results?.first
  if (!prfOutput) {
    throw new Error('WebAuthn PRF extension is not supported or was rejected by authenticator')
  }

  return {
    credentialId: bufferToBase64(credential.rawId),
    prfSalt: bufferToBase64(saltBytes.buffer),
    prfOutput,
  }
}

export async function getPrfOutput(credentialId: string, prfSalt: string): Promise<ArrayBuffer> {
  if (!window.PublicKeyCredential) {
    throw new Error('WebAuthn is not supported on this browser')
  }

  const challenge = new Uint8Array(32)
  crypto.getRandomValues(challenge)

  const rawCredentialId = base64ToBuffer(credentialId)
  const saltBytes = base64ToBuffer(prfSalt)

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: window.location.hostname,
      allowCredentials: [
        {
          id: rawCredentialId,
          type: 'public-key',
        },
      ],
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: saltBytes,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Biometric authentication failed')
  }

  const clientExtensionResults = credential.getClientExtensionResults() as {
    prf?: {
      results?: {
        first?: ArrayBuffer
      }
    }
  }

  const prfOutput = clientExtensionResults?.prf?.results?.first
  if (!prfOutput) {
    throw new Error('Failed to retrieve biometric decryption key via PRF')
  }

  return prfOutput
}
