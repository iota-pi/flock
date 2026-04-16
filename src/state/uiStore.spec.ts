import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore, type UIState } from './uiStore'

const initialState: UIState = {
  activeRequests: 0,
  darkMode: null,
  filters: useUiStore.getState().filters,
  justCreatedAccount: false,
}

describe('uiStore base state actions', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiStore.setState(initialState)
  })

  it('setUi applies payload values for retained ui fields', () => {
    useUiStore.getState().setUi({
      activeRequests: 2,
      darkMode: true,
      justCreatedAccount: true,
    })

    const state = useUiStore.getState()
    expect(state.darkMode).toBe(true)
    expect(state.justCreatedAccount).toBe(true)
    expect(state.activeRequests).toBe(2)
  })

  it('request lifecycle updates active request counter', () => {
    const store = useUiStore.getState()
    store.startRequest()
    store.startRequest()

    let state = useUiStore.getState()
    expect(state.activeRequests).toBe(2)

    store.finishRequest()
    store.finishRequest()
    state = useUiStore.getState()
    expect(state.activeRequests).toBe(0)
  })
})