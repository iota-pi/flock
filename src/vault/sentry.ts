import type { NodeOptions } from '@sentry/node'
import { scrubBreadcrumb, scrubEvent } from '../utils/telemetryScrub'

/**
 * The server's Sentry options. Request bodies carry ciphertext and `authToken`s (which work as
 * passwords), and headers carry session tokens, so events keep neither.
 *
 * Sentry 11 collects every `dataCollection` category by default, so each one that can hold user
 * data is turned off here, and the scrubbers below remove anything that gets through.
 */
export function getServerSentryConfig(dsn: string): NodeOptions {
  return {
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb)
    },
    beforeSend(event) {
      return scrubEvent(event)
    },
  }
}
