import ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import store from './store';
import ThemedApp from './ThemedApp';

ReactDOM.render(
  <Provider store={store}>
    <ThemedApp />
  </Provider>,
  document.querySelector('#root'),
);

serviceWorkerRegistration.register();
