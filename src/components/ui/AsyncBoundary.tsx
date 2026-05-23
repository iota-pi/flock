import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react'
import { Alert, Box, CircularProgress } from '@mui/material'

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
