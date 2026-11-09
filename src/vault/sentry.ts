import type { NodeOptions } from '@sentry/node'
import { scrubBreadcrumb, scrubEvent } from '../utils/telemetryScrub'

/**
 * The server's Sentry options. Request bodies carry ciphertext and `authToken`s (which work as
 * passwords), and headers carry session tokens, so events keep neither.
 */
export function getServerSentryConfig(dsn: string): NodeOptions {
  return {
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.0,
    sendDefaultPii: false,
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb)
    },
    beforeSend(event) {
      return scrubEvent(event)
    },
  }
}
