import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore, type UIState } from './uiStore'

const initialState: UIState = {
  darkMode: null,
  dlqCount: 0,
  isSyncing: false,
  offlineQueueLength: 0,
  drawers: [],
  filters: useUiStore.getState().filters,
  message: null,
  requests: { active: 0 },
  selected: [],
  justCreatedAccount: false,
}

describe('uiStore sync state actions', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiStore.setState(initialState)
  })

  it('setUi applies exact sync-related payload values', () => {
    useUiStore.getState().setUi({
      dlqCount: 4,
      isSyncing: true,
      offlineQueueLength: 9,
      requests: { active: 2 },
    })

    const state = useUiStore.getState()
    expect(state.dlqCount).toBe(4)
    expect(state.isSyncing).toBe(true)
    expect(state.offlineQueueLength).toBe(9)
    expect(state.requests.active).toBe(2)
  })

  it('sync state action creators persist injected payload values', () => {
    const store = useUiStore.getState()
    store.setDlqCount(7)
    store.setIsSyncing(true)
    store.setOfflineQueueLength(11)

    let state = useUiStore.getState()
    expect(state.dlqCount).toBe(7)
    expect(state.isSyncing).toBe(true)
    expect(state.offlineQueueLength).toBe(11)

    store.setIsSyncing(false)
    state = useUiStore.getState()
    expect(state.isSyncing).toBe(false)
  })
})