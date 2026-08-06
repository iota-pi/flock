import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'


type AsyncBoundaryProps = {
  children: ReactNode
  loadingFallback?: ReactNode
  errorFallback?: ReactNode | ((error: Error) => ReactNode)
}

type AsyncErrorBoundaryProps = {
  children: ReactNode
  errorFallback?: ReactNode | ((error: Error) => ReactNode)
}

type AsyncErrorBoundaryState = {
  error: Error | null
}

export function isChunkLoadError(error: Error): boolean {
  const message = error.message || ''
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Failed to load module script') ||
    message.includes('Loading chunk') ||
    message.includes('dynamically imported module')
  )
}

function handleChunkErrorReload() {
  const storageKey = 'flock_chunk_reload_attempted'
  const lastAttempt = sessionStorage.getItem(storageKey)
  const now = Date.now()

  // Auto-reload once if not attempted in the last 15 seconds
  if (!lastAttempt || now - parseInt(lastAttempt, 10) > 15000) {
    sessionStorage.setItem(storageKey, now.toString())
    window.location.reload()
  }
}

export function LoadingSpinner() {
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100%",
        width: "100%"
      }}>
      <CircularProgress />
    </Box>
  )
}

function DefaultErrorFallback({ error }: { error: Error }) {
  const isChunkError = isChunkLoadError(error)

  if (isChunkError) {
    return (
      <Alert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => {
              sessionStorage.removeItem('flock_chunk_reload_attempted')
              window.location.reload()
            }}
          >
            Reload Page
          </Button>
        }
      >
        A new version of the app is available or a module failed to load.
      </Alert>
    )
  }

  return (
    <Alert severity="error">
      {error.message || 'Something went wrong while loading this view.'}
    </Alert>
  )
}

class AsyncErrorBoundary extends Component<AsyncErrorBoundaryProps, AsyncErrorBoundaryState> {
  public constructor(props: AsyncErrorBoundaryProps) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): AsyncErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[AsyncBoundary] render failed', error, errorInfo)
    if (isChunkLoadError(error)) {
      handleChunkErrorReload()
    }
  }

  public render(): ReactNode {
    if (this.state.error) {
      const { errorFallback } = this.props
      if (typeof errorFallback === 'function') {
        return errorFallback(this.state.error)
      }

      return errorFallback || <DefaultErrorFallback error={this.state.error} />
    }

    return this.props.children
  }
}

export default function AsyncBoundary({
  children,
  loadingFallback,
  errorFallback,
}: AsyncBoundaryProps) {
  return (
    <AsyncErrorBoundary errorFallback={errorFallback}>
      <Suspense fallback={loadingFallback === undefined ? <LoadingSpinner /> : loadingFallback}>
        {children}
      </Suspense>
    </AsyncErrorBoundary>
  )
}
