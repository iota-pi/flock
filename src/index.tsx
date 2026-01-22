import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import * as serviceWorkerRegistration from './serviceWorkerRegistration'
import store from './store'
import { queryClient, queryKeys, queryPersister } from './api/client'
import ThemedApp from './ThemedApp'


const rootElement = document.getElementById('root')!
const root = createRoot(rootElement)
root.render(
  <Provider store={store}>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      }}
    >
      <ThemedApp />
    </PersistQueryClientProvider>
  </Provider>,
)

serviceWorkerRegistration.register()

if (window.Cypress) {
  window.vault = import('./api/Vault')
  window.mutations = import('./api/mutations')
  window.invalidateQuery = (key: keyof typeof queryKeys) => queryClient.invalidateQueries({ queryKey: queryKeys[key] })
  window.queryKeys = queryKeys
}
