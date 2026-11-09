import { getServerSentryConfig } from './sentry'

describe('getServerSentryConfig', () => {
  it('turns off default PII', () => {
    expect(getServerSentryConfig('https://fake@sentry.io/1').sendDefaultPii).toBe(false)
  })

  it('removes request bodies and auth headers from events', () => {
    const config = getServerSentryConfig('https://fake@sentry.io/1')
    const event = {
      type: undefined,
      request: {
        url: '/trpc/accounts.changePassword',
        data: { authToken: 'secret', newAuthToken: 'secret' },
        headers: { authorization: 'Bearer secret', cookie: 'a=b', 'content-type': 'application/json' },
      },
    }
    expect(config.beforeSend?.(event as any, {})).toEqual({
      type: undefined,
      request: { url: '/trpc/accounts.changePassword', headers: { 'content-type': 'application/json' } },
    })
  })

  it('drops console breadcrumbs', () => {
    const config = getServerSentryConfig('https://fake@sentry.io/1')
    expect(config.beforeBreadcrumb?.({ category: 'console', message: '[TRPC Error]' })).toBeNull()
  })
})
