export function getNextDarkMode(darkMode: boolean | null) {
  if (darkMode === null) {
    return true
  } else if (darkMode === false) {
    return null
  }
  return false
}
