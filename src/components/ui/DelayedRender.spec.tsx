import { act, render, screen } from '@testing-library/react'

import DelayedRender from './DelayedRender'

describe('DelayedRender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('shows fallback until the default delay has elapsed', () => {
    render(
      <DelayedRender fallback={<div>Loading</div>}>
        <div>Content</div>
      </DelayedRender>
    )

    expect(screen.getByText('Loading')).toBeTruthy()
    expect(screen.queryByText('Content')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(99)
    })
    expect(screen.queryByText('Content')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('Content')).toBeTruthy()
  })

  it('renders children immediately when delay is zero', () => {
    render(
      <DelayedRender delayMs={0}>
        <div>Content</div>
      </DelayedRender>
    )

    expect(screen.getByText('Content')).toBeTruthy()
  })

  it('renders null before delay when fallback is not provided', () => {
    render(
      <DelayedRender>
        <div>Content</div>
      </DelayedRender>
    )

    expect(screen.queryByText('Content')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getByText('Content')).toBeTruthy()
  })
})