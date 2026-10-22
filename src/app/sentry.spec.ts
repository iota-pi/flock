import * as Sentry from '@sentry/react'
import {
  filterIgnoredEvents,
  getAppSentryConfig,
  initAppSentry,
  matchesAny,
  toErrorText,
  NETWORK_ERROR_MATCHERS,
} from './sentry'

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
}))

describe('sentry configuration and filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('toErrorText', () => {
    it('extracts top-level message and exception values', () => {
      const event = {
        message: 'Top-level message',
        exception: {
          values: [
            { type: 'TypeError', value: 'Cannot read property' },
            { type: 'Error', value: 'Network failed' },
          ],
        },
      }
      expect(toErrorText(event)).toBe('Top-level message TypeError Cannot read property Error Network failed')
    })

    it('handles event without message or exceptions', () => {
      expect(toErrorText({})).toBe('')
    })
  })

  describe('matchesAny', () => {
    it('matches string matchers case-insensitively', () => {
      expect(matchesAny('failed to fetch resource', NETWORK_ERROR_MATCHERS)).toBe(true)
      expect(matchesAny('something else entirely', NETWORK_ERROR_MATCHERS)).toBe(false)
    })

    it('matches regex matchers', () => {
      expect(matchesAny('TRPCClientError: fetch failed [500]', NETWORK_ERROR_MATCHERS)).toBe(true)
    })
  })

  describe('filterIgnoredEvents', () => {
    it('drops network errors', () => {
      const event = {
        exception: {
          values: [{ type: 'TypeError', value: 'Failed to fetch' }],
        },
      }
      expect(filterIgnoredEvents(event)).toBeNull()
    })

    it('drops background sync and timeout errors', () => {
      const event = {
        message: 'The operation timed out during background sync',
      }
      expect(filterIgnoredEvents(event)).toBeNull()
    })

    it('retains non-network error events', () => {
      const event = {
        exception: {
          values: [{ type: 'Error', value: 'Unexpected application crash' }],
        },
      }
      expect(filterIgnoredEvents(event)).toBe(event)
    })

    it('returns event unchanged if text is empty', () => {
      const event = {}
      expect(filterIgnoredEvents(event)).toBe(event)
    })
  })

  describe('getAppSentryConfig', () => {
    it('sets initialScope app tag and shared options for main app', () => {
      const config = getAppSentryConfig({ app: 'main' })
      expect(config.initialScope).toEqual({ tags: { app: 'main' } })
      expect(config.tracesSampleRate).toBe(0.0)
      expect(config.ignoreErrors).toContain('CLIENT_OUTDATED')
    })

    it('sets initialScope app tag for migrate app', () => {
      const config = getAppSentryConfig({ app: 'migrate' })
      expect(config.initialScope).toEqual({ tags: { app: 'migrate' } })
    })

    it('wires beforeSend filter in returned config', () => {
      const config = getAppSentryConfig({ app: 'main' })
      const networkEvent = {
        exception: { values: [{ value: 'Failed to fetch' }] },
      }
      expect(config.beforeSend?.(networkEvent as any, {})).toBeNull()
    })
  })

  describe('initAppSentry', () => {
    it('calls Sentry.init with app config', () => {
      initAppSentry({ app: 'migrate' })
      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          initialScope: { tags: { app: 'migrate' } },
          ignoreErrors: expect.arrayContaining(['CLIENT_OUTDATED', 'Failed to fetch']),
        }),
      )
    })
  })
})
