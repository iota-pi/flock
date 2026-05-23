import {
  CssBaseline,
  ThemeProvider,
} from '@mui/material'
import { StyledEngineProvider } from '@mui/material/styles'
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
