export const BIOMETRIC_STORAGE_KEY = 'FlockBiometricData'

export type BiometricStoredData = {
  account?: string
  credentialId: string
  prfSalt: string
  encryptedMasterKey: {
    iv: string
    cipher: string
  }
}

export function readBiometricData(): BiometricStoredData | null {
  if (typeof localStorage === 'undefined') return null
  const serialized = localStorage.getItem(BIOMETRIC_STORAGE_KEY)
  if (!serialized) return null
  try {
    const parsed = JSON.parse(serialized) as Partial<BiometricStoredData>
    if (
      typeof parsed.credentialId === 'string' &&
      typeof parsed.prfSalt === 'string' &&
      parsed.encryptedMasterKey &&
      typeof parsed.encryptedMasterKey.iv === 'string' &&
      typeof parsed.encryptedMasterKey.cipher === 'string'
    ) {
      return {
        account: typeof parsed.account === 'string' ? parsed.account : undefined,
        credentialId: parsed.credentialId,
        prfSalt: parsed.prfSalt,
        encryptedMasterKey: parsed.encryptedMasterKey,
      }
    }
  } catch {
    clearBiometricData()
  }
  return null
}

export function writeBiometricData(data: BiometricStoredData): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(BIOMETRIC_STORAGE_KEY, JSON.stringify(data))
}

export function clearBiometricData(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(BIOMETRIC_STORAGE_KEY)
}

export function hasBiometricData(): boolean {
  return readBiometricData() !== null
}
