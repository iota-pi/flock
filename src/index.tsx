import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import * as serviceWorkerRegistration from './serviceWorkerRegistration'
import store from './store'
import { queryClient, queryKeys, queryPersister } from './api/queries'
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ; (window as any).invalidateQuery = (key: string) => queryClient.invalidateQueries({ queryKey: (queryKeys as any)[key] })
  window.queryKeys = queryKeys
}
