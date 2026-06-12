import { useAppStore } from '../store'
import type { UIState } from './uiSlice'


const initialState: UIState = {
  activeRequests: 0,
  darkMode: null,
  filters: useAppStore.getState().filters,
  justCreatedAccount: false,
}

describe('uiSlice', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useAppStore.setState(initialState)
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
})