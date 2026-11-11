/** The build's commit (set by CI), shortened the way git does */
export function getAppVersion(release = import.meta.env.VITE_RELEASE): string {
  return release ? release.slice(0, 7) : 'development'
}
