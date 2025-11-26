export function almostConstantTimeEqual(attempt: string, real: string) {
  if (attempt.length !== real.length) {
    return false
  }

  let equal = true
  for (let i = 0; i < attempt.length; i++) {
    if (attempt.charAt(i) !== real.charAt(i)) {
      equal = false
    }
  }

  return equal
}

export function generateAccountId() {
  return Math.random().toString(36).substring(2, 6)
}
