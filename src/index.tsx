// TODO: enable StrictMode
// import { StrictMode } from 'react'
// Configures the vault before any other module can use it
import './app/vault/setup'
import './fonts'
import { createRoot } from 'react-dom/client'
import { initAppSentry } from './app/sentry'
// eslint-disable-next-line import-x/no-unresolved
import { registerSW } from 'virtual:pwa-register'
import { registerAppUpdates } from './app/appUpdate'
import { hasApiAuthToken } from '@vault/client'
import ThemedApp from './ThemedApp'

initAppSentry({ app: 'main' })

function initializeApp() {
  try {
    const rootElement = document.getElementById('root')!
    const root = createRoot(rootElement)
    root.render(<ThemedApp />)

    registerAppUpdates(registerSW)

    if (window.Cypress) {
      window.hasApiAuthToken = hasApiAuthToken
      window.vault = import('@vault/client')
      window.mutations = import('./features/items/mutations/itemMutations')
      window.syncBridge = import('./app/vault/syncBridge').then(mod => mod.SyncBridge)
    }
  } catch (error) {
    console.error('Failed to initialize application core:', error)
    const rootElement = document.getElementById('root')
    if (rootElement) {
      rootElement.innerText = 'Failed to initialize application core. Please refresh the page.'
    }
  }
}

initializeApp()
