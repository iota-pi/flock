/**
 * The in-app path a push notification may open, from the `url` in its payload. Push payloads come
 * from the server, which mustn't be able to send the user anywhere but this app: anything that
 * isn't a path on this origin (or names the migration app, a separate page) opens the home page.
 */
export function getNotificationTarget(url: unknown, origin: string): string {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return '/'
  let parsed: URL
  try {
    parsed = new URL(url, origin)
  } catch {
    return '/'
  }
  if (parsed.origin !== origin || /^\/migrate(\/|$)/.test(parsed.pathname)) return '/'
  return parsed.pathname + parsed.search + parsed.hash
}
