import React from 'react';
import ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import CssBaseline from '@material-ui/core/CssBaseline';
import { ThemeProvider } from '@material-ui/core/styles';
import App from './App';
import store from './store';
import theme from './theme';

ReactDOM.render(
  <ThemeProvider theme={theme}>
    <CssBaseline />

    <Provider store={store}>
      <App />
    </Provider>
  </ThemeProvider>,
  document.querySelector('#root'),
);
