// Configures the vault before any other module can use it
import './setup'
import { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { StyledEngineProvider, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import getTheme from '../theme'
import MigrateApp from './MigrateApp'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_RELEASE || undefined,
  tracesSampleRate: 0.0,
  initialScope: { tags: { app: 'migrate' } },
})

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
