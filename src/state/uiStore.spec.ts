import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore, type UIState } from './uiStore'

const initialState: UIState = {
  darkMode: null,
  filters: useUiStore.getState().filters,
  requests: { active: 0 },
  justCreatedAccount: false,
}

describe('uiStore base state actions', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiStore.setState(initialState)
  })

  it('setUi applies payload values for retained ui fields', () => {
    useUiStore.getState().setUi({
      darkMode: true,
      justCreatedAccount: true,
      requests: { active: 2 },
    })

    const state = useUiStore.getState()
    expect(state.darkMode).toBe(true)
    expect(state.justCreatedAccount).toBe(true)
    expect(state.requests.active).toBe(2)
  })

  it('request lifecycle updates active request counter', () => {
    const store = useUiStore.getState()
    store.startRequest()
    store.startRequest()

    let state = useUiStore.getState()
    expect(state.requests.active).toBe(2)

    store.finishRequest()
    store.finishRequest()
    state = useUiStore.getState()
    expect(state.requests.active).toBe(0)
  })
})