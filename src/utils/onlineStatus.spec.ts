import { getOnlineState } from './onlineStatus'

describe('getOnlineState utility', () => {
  let onLineSpy: any
  let visibilityStateSpy: any

  beforeEach(() => {
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    visibilityStateSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return true when online and visible', () => {
    expect(getOnlineState()).toBe(true)
  })

  it('should return false when offline and visible', () => {
    onLineSpy.mockReturnValue(false)
    expect(getOnlineState()).toBe(false)
  })

  it('should return false when online and hidden', () => {
    visibilityStateSpy.mockReturnValue('hidden')
    expect(getOnlineState()).toBe(false)
  })

  it('should return false when offline and hidden', () => {
    onLineSpy.mockReturnValue(false)
    visibilityStateSpy.mockReturnValue('hidden')
    expect(getOnlineState()).toBe(false)
  })
})
