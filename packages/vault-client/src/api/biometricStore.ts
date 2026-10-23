import { getVaultStorageNames } from '../sync/shared/storageNames'
import { createLogger } from '../sync/utils/logger'

const log = createLogger('biometricStore')

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
      log.error('listener error', e)
    }
  })
}

export function subscribeBiometrics(callback: () => void): () => void {
  listeners.add(callback)
  const onStorage = (e: StorageEvent) => {
    if (e.key === getVaultStorageNames().biometricDataKey) {
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
  const serialized = localStorage.getItem(getVaultStorageNames().biometricDataKey)
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
  localStorage.setItem(getVaultStorageNames().biometricDataKey, JSON.stringify(data))
  notifyBiometricsChanged()
}

export function clearBiometricData(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(getVaultStorageNames().biometricDataKey)
  notifyBiometricsChanged()
}

export function hasBiometricData(): boolean {
  return readBiometricData() !== null
}
