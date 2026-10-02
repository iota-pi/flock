import { render, screen } from '@testing-library/react'
import * as Sentry from '@sentry/react'
import AsyncBoundary from './AsyncBoundary'

vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}))

function ThrowingComponent({ error }: { error: Error }): never {
  throw error
}

describe('AsyncBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(Sentry.captureException).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('renders children normally when no error occurs', () => {
    render(
      <AsyncBoundary>
        <div>Content Rendered</div>
      </AsyncBoundary>
    )

    expect(screen.getByText('Content Rendered')).toBeTruthy()
  })

  it('catches render errors, renders fallback, and reports to Sentry', () => {
    const testError = new Error('Test render crash')

    render(
      <AsyncBoundary>
        <ThrowingComponent error={testError} />
      </AsyncBoundary>
    )

    expect(screen.getByText('Test render crash')).toBeTruthy()
    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    expect(Sentry.captureException).toHaveBeenCalledWith(testError, {
      extra: {
        componentStack: expect.any(String),
      },
      tags: {
        boundary: 'AsyncBoundary',
      },
    })
  })

  it('handles chunk load errors with reload alert and suppresses Sentry report', () => {
    const chunkError = new Error('Failed to fetch dynamically imported module /src/features/items.js')

    render(
      <AsyncBoundary>
        <ThrowingComponent error={chunkError} />
      </AsyncBoundary>
    )

    expect(
      screen.getByText(/A new version of the app is available or a module failed to load/)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reload Page/i })).toBeTruthy()
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })
})
