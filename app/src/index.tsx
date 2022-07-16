import ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import store from './store';
import configureHokeys from './utils/hotkeys';
import ThemedApp from './ThemedApp';

configureHokeys();

ReactDOM.render(
  <Provider store={store}>
    <ThemedApp />
  </Provider>,
  document.querySelector('#root'),
);

serviceWorkerRegistration.register();
