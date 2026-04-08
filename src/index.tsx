import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
// eslint-disable-next-line import-x/no-unresolved
import { registerSW } from 'virtual:pwa-register'
import * as vault from './api/vault'
import * as mutations from './features/items/mutations/itemMutations'
import ThemedApp from './ThemedApp'

const NETWORK_ERROR_MATCHERS: Array<string | RegExp> = [
  'Failed to fetch',
  'NetworkError when attempting to fetch resource',
  'The network connection was lost.',
  /Network error/i,
  /TRPCClientError: fetch failed/i,
]

const BACKGROUND_SYNC_OR_TIMEOUT_MATCHERS: RegExp[] = [
  /timeout/i,
  /timed out/i,
  /background sync/i,
  /sync-vault/i,
]

type SentryEventLike = {
  message?: string
  exception?: {
    values?: Array<{
      type?: string
      value?: string
    }>
  }
}

function toErrorText(event: SentryEventLike): string {
  const message = event.message || ''
  const exceptionValues = event.exception?.values || []
  const exceptionText = exceptionValues
    .map((value: { type?: string; value?: string }) => `${value.type || ''} ${value.value || ''}`.trim())
    .join(' ')

  return `${message} ${exceptionText}`.trim()
}

function matchesAny(text: string, matchers: Array<string | RegExp>): boolean {
  return matchers.some(matcher => (
    typeof matcher === 'string'
      ? text.includes(matcher.toLowerCase())
      : matcher.test(text)
  ))
}

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  tracesSampleRate: 0.0,
  ignoreErrors: NETWORK_ERROR_MATCHERS,
  beforeSend(event) {
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
  },
})


const rootElement = document.getElementById('root')!
const root = createRoot(rootElement)
root.render(<ThemedApp />)

registerSW()

if (window.Cypress) {
  window.vault = Promise.resolve(vault)
  window.mutations = Promise.resolve(mutations)
}
