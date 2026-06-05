import { act, renderHook } from '@testing-library/react'
import { useOnlineStatus } from './useOnlineStatus'

describe('useOnlineStatus hook', () => {
  let onLineSpy: any
  let visibilityStateSpy: any

  beforeEach(() => {
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    visibilityStateSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return true when navigator.onLine is true and document is visible', () => {
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)
  })

  it('should return false when navigator.onLine is false and document is visible', () => {
    onLineSpy.mockReturnValue(false)
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)
  })

  it('should return false when navigator.onLine is true and document is hidden', () => {
    visibilityStateSpy.mockReturnValue('hidden')
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)
  })

  it('should update state when online/offline events are fired', () => {
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)

    // Go offline
    onLineSpy.mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(result.current).toBe(false)

    // Go online
    onLineSpy.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(result.current).toBe(true)
  })

  it('should update state when visibilitychange event is fired', () => {
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)

    // Hide document
    visibilityStateSpy.mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe(false)

    // Make document visible
    visibilityStateSpy.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe(true)
  })
})
