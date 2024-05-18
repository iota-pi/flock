export function almostConstantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false
  }

  let equal = true
  for (let i = 0; i < a.length; i++) {
    if (a.charAt(i) !== b.charAt(i)) {
      equal = false
    }
  }

  return equal
}
