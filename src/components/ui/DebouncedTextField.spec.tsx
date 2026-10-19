import type { MutableRefObject } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

  it('sets enterkeyhint="done" on single-line inputs by default', () => {
    render(
      <DebouncedTextField
        label="Name"
        onCommit={vi.fn()}
        value=""
      />,
    )

    const input = screen.getByLabelText('Name')
    expect(input.getAttribute('enterkeyhint')).toBe('done')
  })

  it('blurs input and commits immediately on Enter key press for single-line field', () => {
    const onCommit = vi.fn()

    render(
      <DebouncedTextField
        debounceMs={1000}
        label="Name"
        onCommit={onCommit}
        value=""
      />,
    )

    const input = screen.getByLabelText('Name') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'Committed on Enter' } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.activeElement).not.toBe(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('Committed on Enter')
  })

  it('does not blur or prematurely commit on Enter when multiline is true, and omits enterkeyhint', () => {
    const onCommit = vi.fn()

    render(
      <DebouncedTextField
        debounceMs={1000}
        label="Notes"
        multiline
        onCommit={onCommit}
        value=""
      />,
    )

    const input = screen.getByLabelText('Notes') as HTMLTextAreaElement
    expect(input.getAttribute('enterkeyhint')).toBeNull()

    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'Multiline text' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.activeElement).toBe(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not blur on Enter when IME is composing', () => {
    const onCommit = vi.fn()

    render(
      <DebouncedTextField
        debounceMs={1000}
        label="Name"
        onCommit={onCommit}
        value=""
      />,
    )

    const input = screen.getByLabelText('Name') as HTMLInputElement
    input.focus()

    fireEvent.change(input, { target: { value: 'Composing' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    expect(document.activeElement).toBe(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('respects blurOnEnter={false} when explicitly provided', () => {
    const onCommit = vi.fn()

    render(
      <DebouncedTextField
        blurOnEnter={false}
        debounceMs={1000}
        label="Name"
        onCommit={onCommit}
        value=""
      />,
    )

    const input = screen.getByLabelText('Name') as HTMLInputElement
    expect(input.getAttribute('enterkeyhint')).toBeNull()

    input.focus()
    fireEvent.change(input, { target: { value: 'No blur' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.activeElement).toBe(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('respects caller-provided enterKeyHint in slotProps', () => {
    render(
      <DebouncedTextField
        label="Search"
        onCommit={vi.fn()}
        slotProps={{ htmlInput: { enterKeyHint: 'search' } }}
        value=""
      />,
    )

    const input = screen.getByLabelText('Search')
    expect(input.getAttribute('enterkeyhint')).toBe('search')
  })
})
