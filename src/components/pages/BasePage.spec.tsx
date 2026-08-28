import { act, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material/styles'
import { createMemoryRouter, RouterProvider } from 'react-router'
import BasePage from './BasePage'
import { useAppStore } from '../../state/store'
import getTheme from '../../theme'

const lightTheme = getTheme(false)

const renderWithProviders = (ui: React.ReactNode) => {
  const router = createMemoryRouter([
    {
      path: '/',
      element: ui,
      handle: { isPage: true },
    },
  ])
  return render(
    <ThemeProvider theme={lightTheme}>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}

describe('BasePage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    act(() => {
      useAppStore.setState({
        activeRequests: 0,
        syncStatus: 'idle',
      })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders children correctly', () => {
    renderWithProviders(
      <BasePage>
        <div>Test Page Content</div>
      </BasePage>
    )

    expect(screen.getByText('Test Page Content')).toBeDefined()
  })

  it('shows loading indicator immediately when activeRequests > 0 and debounces removal', () => {
    const { container } = renderWithProviders(
      <BasePage>
        <div>Content</div>
      </BasePage>
    )

    // Initially, progress element is hidden (opacity: 0 / visibility: hidden)
    const progress = container.querySelector('[data-cy="loading-progress"]')
    expect(progress).toBeDefined()
    expect(progress?.getAttribute('style')).toContain('visibility: hidden')

    // Start request
    act(() => {
      useAppStore.setState({ activeRequests: 1 })
    })

    // Progress becomes visible immediately (opacity: 1, not hidden)
    expect(progress?.getAttribute('style')).not.toContain('opacity: 0')
    expect(progress?.getAttribute('style')).not.toContain('visibility: hidden')

    // Finish request
    act(() => {
      useAppStore.setState({ activeRequests: 0 })
    })

    // Should still be visible immediately due to debounce
    expect(progress?.getAttribute('style')).not.toContain('opacity: 0')
    expect(progress?.getAttribute('style')).not.toContain('visibility: hidden')

    // Advance 100ms (halfway through 200ms debounce)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(progress?.getAttribute('style')).not.toContain('opacity: 0')
    expect(progress?.getAttribute('style')).not.toContain('visibility: hidden')

    // Advance past 200ms debounce (Fade begins transition to opacity: 0)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(progress?.getAttribute('style')).toContain('opacity: 0')

    // Advance past MUI Fade exit transition (195ms)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(progress?.getAttribute('style')).toContain('visibility: hidden')
  })

  it('shows loading indicator when syncStatus is syncing and debounces return to idle', () => {
    const { container } = renderWithProviders(
      <BasePage>
        <div>Content</div>
      </BasePage>
    )

    const progress = container.querySelector('[data-cy="loading-progress"]')
    expect(progress?.getAttribute('style')).toContain('visibility: hidden')

    // Syncing state
    act(() => {
      useAppStore.setState({ syncStatus: 'syncing' })
    })
    expect(progress?.getAttribute('style')).not.toContain('opacity: 0')
    expect(progress?.getAttribute('style')).not.toContain('visibility: hidden')

    // Back to idle
    act(() => {
      useAppStore.setState({ syncStatus: 'idle' })
    })
    // Debounce keeps it visible
    expect(progress?.getAttribute('style')).not.toContain('opacity: 0')
    expect(progress?.getAttribute('style')).not.toContain('visibility: hidden')

    // Advance past 200ms debounce
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(progress?.getAttribute('style')).toContain('opacity: 0')

    // Advance past MUI Fade exit transition
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(progress?.getAttribute('style')).toContain('visibility: hidden')
  })

  it('does not render loading bar when showLoading is false', () => {
    const { container } = renderWithProviders(
      <BasePage showLoading={false}>
        <div>Content</div>
      </BasePage>
    )

    expect(container.querySelector('[data-cy="loading-progress"]')).toBeNull()
  })
})
