import {
  CssBaseline,
  Theme,
  ThemeProvider,
  StyledEngineProvider,
} from '@material-ui/core';
import { useMemo } from 'react';
import App from './App';
import { useAppSelector } from './store';
import getTheme from './theme';

declare module '@material-ui/styles/defaultTheme' {
  interface DefaultTheme extends Theme {}
}

export default function ThemedApp() {
  const darkMode = useAppSelector(state => state.ui.darkMode);
  const theme = useMemo(() => getTheme(darkMode), [darkMode]);

  return (
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </StyledEngineProvider>
  );
}
