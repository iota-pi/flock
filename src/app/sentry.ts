import * as Sentry from '@sentry/react'
import { CLIENT_OUTDATED_MESSAGE } from '@vault/shared'

export const NETWORK_ERROR_MATCHERS: Array<string | RegExp> = [
  'Failed to fetch',
  'NetworkError when attempting to fetch resource',
  'The network connection was lost.',
  /Network error/i,
  /TRPCClientError: fetch failed/i,
]

export const BACKGROUND_SYNC_OR_TIMEOUT_MATCHERS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /background sync/i,
  /sync-vault/i,
]

export type SentryEventLike = {
  message?: string
  exception?: {
    values?: Array<{
      type?: string
      value?: string
    }>
  }
}

export function toErrorText(event: SentryEventLike): string {
  const message = event.message || ''
  const exceptionValues = event.exception?.values || []
  const exceptionText = exceptionValues
    .map(value => `${value.type || ''} ${value.value || ''}`.trim())
    .join(' ')

  return `${message} ${exceptionText}`.trim()
}

export function matchesAny(text: string, matchers: Array<string | RegExp>): boolean {
  return matchers.some(matcher => (
    typeof matcher === 'string'
      ? text.includes(matcher.toLowerCase())
      : matcher.test(text)
  ))
}

export function filterIgnoredEvents<T extends SentryEventLike>(event: T): T | null {
  const text = toErrorText(event).toLowerCase()
  if (!text) {
    return event
  }

  const isLikelyNetworkError = matchesAny(text, NETWORK_ERROR_MATCHERS)
  const isBackgroundSyncOrTimeout = matchesAny(text, BACKGROUND_SYNC_OR_TIMEOUT_MATCHERS)

  if (isLikelyNetworkError || isBackgroundSyncOrTimeout) {
    return null
  }

  return event
}

export type AppName = 'main' | 'migrate'

export interface AppSentryOptions {
  app: AppName
}

export type SentryInitOptions = Parameters<typeof Sentry.init>[0]

export function getAppSentryConfig({ app }: AppSentryOptions): SentryInitOptions {
  return {
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE || undefined,
    tracesSampleRate: 0.0,
    ignoreErrors: [...NETWORK_ERROR_MATCHERS, CLIENT_OUTDATED_MESSAGE],
    initialScope: { tags: { app } },
    beforeSend(event) {
      return filterIgnoredEvents(event)
    },
  }
}

export function initAppSentry(options: AppSentryOptions): void {
  Sentry.init(getAppSentryConfig(options))
}
