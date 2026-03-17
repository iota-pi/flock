import {
  CssBaseline,
  ThemeProvider,
  StyledEngineProvider,
} from '@mui/material'
import { useMemo } from 'react'
import App from './App'
import { useUiStore } from './state/uiStore'
import getTheme from './theme'


export default function ThemedApp() {
  const darkMode = useUiStore(state => state.darkMode)
  const theme = useMemo(() => getTheme(darkMode), [darkMode])

  return (
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </StyledEngineProvider>
  )
}
