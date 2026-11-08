// A path that names a file other than an HTML page, such as /assets/main-abc123.js or /favicon.ico
const NON_HTML_FILE = /\.(?!html?$)[a-z0-9]+$/i

/**
 * Whether a response for a file (a script, stylesheet, image...) is really an HTML page. When a
 * file is missing, the site answers with the app shell (its single-page-app fallback) and status 200,
 * so a script from a build that's no longer deployed comes back as HTML. It must never be cached
 * as the file.
 */
export function isPageInPlaceOfFile(url: string, response: Response): boolean {
  const { pathname } = new URL(url, 'https://flock.invalid')
  return NON_HTML_FILE.test(pathname) && (response.headers.get('Content-Type') ?? '').includes('text/html')
}
