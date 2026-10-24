/** What this device calls its biometric unlock, for labels and messages */
export function getBiometricLabel(): string {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'Biometrics'
  }
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'Touch ID / Face ID'
  }
  if (/Macintosh|Mac OS X/.test(ua)) {
    return 'Touch ID'
  }
  if (/Windows/.test(ua)) {
    return 'Windows Hello'
  }
  if (/Android/.test(ua)) {
    return 'Fingerprint / Face Unlock'
  }
  return 'Biometrics'
}
