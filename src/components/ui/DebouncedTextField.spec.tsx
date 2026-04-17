import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import DebouncedTextField, { type DebouncedTextFieldControls } from './DebouncedTextField'

describe('DebouncedTextField', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('updates local input immediately and commits after debounce delay', () => {
    const onCommit = vi.fn()

    render(
      <DebouncedTextField
        debounceMs={100}
        label="Name"
        onCommit={onCommit}
        value="Initial"
      />,
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    const input = screen.getByLabelText('Name') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Updated Name' } })

    expect(input.value).toBe('Updated Name')
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(99)
    })
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('Updated Name')
  })

  it('flushes pending value on blur', () => {
    const onCommit = vi.fn()

    render(
      <DebouncedTextField
        debounceMs={500}
        label="Description"
        onCommit={onCommit}
        value=""
      />,
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    const input = screen.getByLabelText('Description') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Blur commit' } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('Blur commit')
  })

  it('flushes pending value on unmount by default', () => {
    const onCommit = vi.fn()

    const { unmount } = render(
      <DebouncedTextField
        debounceMs={500}
        label="Title"
        onCommit={onCommit}
        value=""
      />,
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    const input = screen.getByLabelText('Title') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Unmount commit' } })
    expect(onCommit).not.toHaveBeenCalled()

    unmount()

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('Unmount commit')
  })

  it('syncs external value changes and cancels pending local commits', () => {
    const onCommit = vi.fn()

    const { rerender } = render(
      <DebouncedTextField
        debounceMs={200}
        label="Name"
        onCommit={onCommit}
        value="Initial"
      />,
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    const input = screen.getByLabelText('Name') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Local unsent' } })
    expect(input.value).toBe('Local unsent')
    expect(onCommit).not.toHaveBeenCalled()

    rerender(
      <DebouncedTextField
        debounceMs={200}
        label="Name"
        onCommit={onCommit}
        value="Remote value"
      />,
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(input.value).toBe('Remote value')

    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(onCommit).not.toHaveBeenCalled()
  })

  it('exposes debounce controls for cancel and flush operations', () => {
    const onCommit = vi.fn()
    const controlsRef = {
      current: null,
    } as MutableRefObject<DebouncedTextFieldControls | null>

    render(
      <DebouncedTextField
        debounceControlsRef={controlsRef}
        debounceMs={200}
        label="Name"
        onCommit={onCommit}
        value=""
      />,
    )

    act(() => {
      vi.advanceTimersByTime(0)
    })

    const input = screen.getByLabelText('Name') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Cancelled value' } })
    controlsRef.current?.cancel()

    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'Flushed value' } })
    controlsRef.current?.flush()

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('Flushed value')
  })
})
