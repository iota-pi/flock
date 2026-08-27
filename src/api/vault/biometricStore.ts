export const BIOMETRIC_STORAGE_KEY = 'FlockBiometricData'
export const BIOMETRICS_CHANGED_EVENT = 'flock-biometrics-changed'

export type BiometricStoredData = {
  account?: string
  credentialId: string
  prfSalt: string
  encryptedMasterKey: {
    iv: string
    cipher: string
  }
}

const listeners = new Set<() => void>()

function notifyBiometricsChanged(): void {
  listeners.forEach(listener => {
    try {
      listener()
    } catch (e) {
      console.error('[biometricStore] listener error', e)
    }
  })
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BIOMETRICS_CHANGED_EVENT))
  }
}

export function subscribeBiometrics(callback: () => void): () => void {
  listeners.add(callback)
  const onStorage = (e: StorageEvent) => {
    if (e.key === BIOMETRIC_STORAGE_KEY) {
      callback()
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(callback)
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
    }
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
  notifyBiometricsChanged()
}

export function clearBiometricData(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(BIOMETRIC_STORAGE_KEY)
  notifyBiometricsChanged()
}

export function hasBiometricData(): boolean {
  return readBiometricData() !== null
}
