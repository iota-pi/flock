// Configures the vault before any other module can use it
import './setup'
import '../fonts'
import { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { initAppSentry } from '../app/sentry'
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import getTheme from '../theme'
import MigrateApp from './MigrateApp'

initAppSentry({ app: 'migrate' })

function MigrateRoot() {
  const theme = useMemo(() => getTheme(null), [])
  return (
    <StyledEngineProvider injectFirst>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <MigrateApp />
      </ThemeProvider>
    </StyledEngineProvider>
  )
}

createRoot(document.getElementById('root')!).render(<MigrateRoot />)
