import { useMemo } from 'react'
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'

import App from './App'
import getTheme from './theme'
import { useAppStore } from './state/store'


export default function ThemedApp() {
  const darkMode = useAppStore(state => state.darkMode)
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
