import { scrubBreadcrumb, scrubEvent, scrubSelector, scrubText, scrubUrl } from './telemetryScrub'

describe('scrubUrl', () => {
  it('drops the query and fragment', () => {
    expect(scrubUrl('https://api.example.com/trpc/items.get?input=%7B%22a%22%3A1%7D#x')).toBe(
      'https://api.example.com/trpc/items.get',
    )
    expect(scrubUrl('/people#notes')).toBe('/people')
  })

  it('leaves a URL without either alone', () => {
    expect(scrubUrl('https://example.com/a/b')).toBe('https://example.com/a/b')
  })
})

describe('scrubText', () => {
  it('redacts emails and URL queries', () => {
    expect(scrubText('Failed for jane.smith@example.org at https://x.test/a?q=Jane%20Smith')).toBe(
      'Failed for [email] at https://x.test/a',
    )
  })
})

describe('scrubSelector', () => {
  it('keeps elements, ids and classes but drops attribute values', () => {
    expect(scrubSelector('div.MuiList > li#row-1[aria-label="Jane Smith"] > span[title=\'Grief\']')).toBe(
      'div.MuiList > li#row-1[aria-label] > span[title]',
    )
  })
})

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'note text' })).toBeNull()
  })

  it('scrubs click selectors', () => {
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'button[aria-label="Call Jane"]' })).toEqual({
      category: 'ui.click',
      message: 'button[aria-label]',
    })
  })

  it('scrubs URLs and bodies in data', () => {
    expect(scrubBreadcrumb({
      category: 'fetch',
      data: { url: 'https://api.test/trpc/x?input=secret', method: 'GET', body: 'secret' },
    })).toEqual({ category: 'fetch', data: { url: 'https://api.test/trpc/x', method: 'GET' } })
    expect(scrubBreadcrumb({ category: 'navigation', data: { from: '/a?s=1', to: '/b#c' } })).toEqual({
      category: 'navigation',
      data: { from: '/a', to: '/b' },
    })
  })

  it('keeps the app\'s own breadcrumbs', () => {
    const breadcrumb = { category: 'sync', message: 'Sync status changed to idle' }
    expect(scrubBreadcrumb(breadcrumb)).toEqual(breadcrumb)
  })
})

describe('scrubEvent', () => {
  it('removes bodies, cookies, credentials and queries from requests', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.test/trpc/accounts.login?batch=1',
        query_string: 'batch=1',
        data: '{"authToken":"secret"}',
        cookies: { session: 'secret' },
        headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', 'User-Agent': 'UA' },
      },
    })
    expect(event.request).toEqual({ url: 'https://api.test/trpc/accounts.login', headers: { 'User-Agent': 'UA' } })
  })

  it('keeps only the user ID', () => {
    expect(scrubEvent({ user: { id: 'acc', email: 'a@b.com', ip_address: '1.2.3.4' } }).user).toEqual({ id: 'acc' })
    expect(scrubEvent({ user: { ip_address: '{{auto}}' } }).user).toEqual({})
  })

  it('scrubs messages, exception values and breadcrumbs', () => {
    const event = scrubEvent({
      message: 'from bob@example.com',
      exception: { values: [{ value: 'GET https://x.test/?q=1 failed' }] },
      breadcrumbs: [{ category: 'console', message: 'x' }, { category: 'sync', message: 'ok' }],
    })
    expect(event.message).toBe('from [email]')
    expect(event.exception.values[0].value).toBe('GET https://x.test/ failed')
    expect(event.breadcrumbs).toEqual([{ category: 'sync', message: 'ok' }])
  })
})
