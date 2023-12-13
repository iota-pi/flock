import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import store from './store';
import configureHokeys from './utils/hotkeys';
import ThemedApp from './ThemedApp';

configureHokeys();

const rootElement = document.getElementById('root')!;
const root = createRoot(rootElement);
root.render(
  <Provider store={store}>
    <ThemedApp />
  </Provider>,
);

serviceWorkerRegistration.register();
