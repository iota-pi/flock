import { useMemo } from 'react'
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'

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
