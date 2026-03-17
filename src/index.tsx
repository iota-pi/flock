import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
// eslint-disable-next-line import-x/no-unresolved
import { registerSW } from 'virtual:pwa-register'
import { queryClient, queryKeys, queryPersister } from './api/queryClient'
import ThemedApp from './ThemedApp'


const rootElement = document.getElementById('root')!
const root = createRoot(rootElement)
root.render(
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{
      persister: queryPersister,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    }}
  >
    <ThemedApp />
  </PersistQueryClientProvider>,
)

registerSW()

if (window.Cypress) {
  window.vault = import('./api/Vault')
  window.mutations = import('./api/mutations')
  window.invalidateQuery = (key: keyof typeof queryKeys) => queryClient.invalidateQueries({ queryKey: queryKeys[key] })
  window.queryKeys = queryKeys
}
