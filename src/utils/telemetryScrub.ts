/**
 * Scrubbing for error telemetry (Sentry), shared by the app and the server. Pastoral-care data is
 * special-category data, so nothing a user typed (names, notes, emails) and no credentials may
 * leave in an event. These helpers take plain shapes so that either Sentry SDK's types fit them.
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/gi
const EMAIL_PATTERN = /[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/gi
/** An attribute in a selector Sentry builds for a click, such as `[aria-label="Jane Smith"]` */
const SELECTOR_ATTRIBUTE_PATTERN = /\[([\w-]+)=(?:"[^"]*"|'[^']*'|[^\]]*)\]/g

/** Headers that may be reported, compared in lower case. Everything else is dropped. */
const SAFE_HEADERS = new Set(['user-agent', 'content-type', 'content-length', 'accept', 'x-vault-protocol'])

/** Drops a URL's query and fragment, which can carry tRPC inputs, tokens or search terms */
export function scrubUrl(url: string): string {
  const end = url.search(/[?#]/)
  return end === -1 ? url : url.slice(0, end)
}

/** Strips URLs' queries and redacts email addresses in free text */
export function scrubText(text: string): string {
  return text
    .replace(URL_PATTERN, scrubUrl)
    .replace(EMAIL_PATTERN, '[email]')
}

/** Keeps a click selector's elements, ids and classes, but drops attribute values (labels, titles, names) */
export function scrubSelector(selector: string): string {
  return scrubText(selector.replace(SELECTOR_ATTRIBUTE_PATTERN, '[$1]'))
}

export interface BreadcrumbLike {
  category?: string
  message?: string
  data?: Record<string, unknown>
}

const URL_DATA_KEYS = ['url', 'from', 'to']

/**
 * Returns the breadcrumb with anything sensitive removed, or null to drop it. Console breadcrumbs
 * are always dropped: logged arguments can be anything, including decrypted content.
 */
export function scrubBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T | null {
  const category = breadcrumb.category ?? ''
  if (category === 'console') {
    return null
  }

  const scrubbed = { ...breadcrumb }
  if (typeof scrubbed.message === 'string') {
    scrubbed.message = category.startsWith('ui.')
      ? scrubSelector(scrubbed.message)
      : scrubText(scrubbed.message)
  }
  if (scrubbed.data) {
    const data = { ...scrubbed.data }
    for (const key of URL_DATA_KEYS) {
      const value = data[key]
      if (typeof value === 'string') {
        data[key] = scrubUrl(value)
      }
    }
    // Request and response bodies, if an integration ever adds them
    delete data.body
    delete data.request_body
    delete data.response_body
    scrubbed.data = data
  }
  return scrubbed
}

export interface EventLike {
  message?: string
  exception?: { values?: Array<{ value?: string }> }
  request?: {
    url?: string
    query_string?: unknown
    data?: unknown
    cookies?: unknown
    headers?: Record<string, string>
  }
  user?: { id?: string | number } & Record<string, unknown>
  breadcrumbs?: BreadcrumbLike[]
}

/**
 * Removes request bodies, cookies, credentials, query strings and anything identifying from an
 * event, and redacts emails and URL queries from its messages. Mutates and returns the event.
 */
export function scrubEvent<T extends EventLike>(event: T): T {
  if (event.message) {
    event.message = scrubText(event.message)
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubText(exception.value)
    }
  }

  if (event.request) {
    const request = event.request
    if (request.url) {
      request.url = scrubUrl(request.url)
    }
    delete request.query_string
    delete request.data
    delete request.cookies
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) => SAFE_HEADERS.has(name.toLowerCase())),
      )
    }
  }

  if (event.user) {
    event.user = event.user.id === undefined ? {} : { id: event.user.id }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(breadcrumb => scrubBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is BreadcrumbLike => breadcrumb !== null)
  }

  return event
}
