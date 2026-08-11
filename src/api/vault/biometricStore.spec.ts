import {
  readBiometricData,
  writeBiometricData,
  clearBiometricData,
  hasBiometricData,
  BIOMETRIC_STORAGE_KEY,
} from './biometricStore'

describe('biometricStore', () => {
  beforeEach(() => {
    localStorage.removeItem(BIOMETRIC_STORAGE_KEY)
  })

  it('returns null when no biometric data is stored', () => {
    expect(readBiometricData()).toBeNull()
    expect(hasBiometricData()).toBe(false)
  })

  it('writes and reads biometric data correctly', () => {
    const data = {
      credentialId: 'cred-123',
      prfSalt: 'salt-456',
      encryptedMasterKey: {
        iv: 'iv-789',
        cipher: 'cipher-012',
      },
    }

    writeBiometricData(data)
    expect(hasBiometricData()).toBe(true)
    expect(readBiometricData()).toEqual(data)
  })

  it('clears biometric data', () => {
    const data = {
      credentialId: 'cred-123',
      prfSalt: 'salt-456',
      encryptedMasterKey: {
        iv: 'iv-789',
        cipher: 'cipher-012',
      },
    }

    writeBiometricData(data)
    clearBiometricData()
    expect(hasBiometricData()).toBe(false)
    expect(readBiometricData()).toBeNull()
  })

  it('handles invalid JSON gracefully', () => {
    localStorage.setItem(BIOMETRIC_STORAGE_KEY, 'invalid-json')
    expect(readBiometricData()).toBeNull()
    expect(hasBiometricData()).toBe(false)
  })
})
