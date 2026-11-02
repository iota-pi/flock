import { getOnlineState } from './onlineStatus'

describe('getOnlineState utility', () => {
  let onLineSpy: any

  beforeEach(() => {
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return true when online', () => {
    expect(getOnlineState()).toBe(true)
  })

  it('should return false when offline', () => {
    onLineSpy.mockReturnValue(false)
    expect(getOnlineState()).toBe(false)
  })
})
