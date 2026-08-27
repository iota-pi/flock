import { useAppStore } from '../store'
import type { UIState } from './uiSlice'


const initialState: UIState = {
  activeRequests: 0,
  darkMode: null,
  filters: useAppStore.getState().filters,
  justCreatedAccount: false,
  showArchived: false,
}

describe('uiSlice', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
    useAppStore.setState({ ...initialState, message: null })
  })

  it('setUi applies payload values for retained ui fields', () => {
    useAppStore.getState().setUi({
      activeRequests: 2,
      darkMode: true,
      justCreatedAccount: true,
    })

    const state = useAppStore.getState()
    expect(state.darkMode).toBe(true)
    expect(state.justCreatedAccount).toBe(true)
    expect(state.activeRequests).toBe(2)
  })

  it('request lifecycle updates active request counter', () => {
    const store = useAppStore.getState()
    store.startRequest()
    store.startRequest()

    let state = useAppStore.getState()
    expect(state.activeRequests).toBe(2)

    store.finishRequest()
    store.finishRequest()
    state = useAppStore.getState()
    expect(state.activeRequests).toBe(0)
  })

  it('finishRequest sets error message when online', async () => {
    const onlineStatus = await import('../../utils/onlineStatus')
    vi.spyOn(onlineStatus, 'getOnlineState').mockReturnValue(true)

    const store = useAppStore.getState()
    store.startRequest()
    store.finishRequest('Server error occurred')

    expect(useAppStore.getState().message).toEqual({
      severity: 'error',
      message: 'Server error occurred',
    })
  })

  it('finishRequest does not set error message when offline', async () => {
    const onlineStatus = await import('../../utils/onlineStatus')
    vi.spyOn(onlineStatus, 'getOnlineState').mockReturnValue(false)

    const store = useAppStore.getState()
    store.startRequest()
    store.finishRequest('Server error occurred')

    expect(useAppStore.getState().message).toBeNull()
  })
})