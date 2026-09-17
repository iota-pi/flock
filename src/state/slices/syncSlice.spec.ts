import { useAppStore } from '../store'

describe('syncSlice', () => {
  beforeEach(() => {
    useAppStore.setState({
      syncStatus: 'idle',
      fatalError: null,
      syncWarning: null,
      generation: 0,
      isQuotaExceeded: false,
    })
  })

  it('updates sync status', () => {
    useAppStore.getState().setSyncStatus('syncing')
    expect(useAppStore.getState().syncStatus).toBe('syncing')
  })

  it('updates fatal error', () => {
    useAppStore.getState().setFatalError('Fatal crash')
    expect(useAppStore.getState().fatalError).toBe('Fatal crash')

    useAppStore.getState().clearFatalError()
    expect(useAppStore.getState().fatalError).toBeNull()
  })

  it('updates sync warning', () => {
    useAppStore.getState().setSyncWarning('Warning msg')
    expect(useAppStore.getState().syncWarning).toBe('Warning msg')

    useAppStore.getState().clearSyncWarning()
    expect(useAppStore.getState().syncWarning).toBeNull()
  })

  it('updates quota exceeded state', () => {
    useAppStore.getState().setQuotaExceeded(true)
    expect(useAppStore.getState().isQuotaExceeded).toBe(true)

    useAppStore.getState().clearQuotaExceeded()
    expect(useAppStore.getState().isQuotaExceeded).toBe(false)
  })

  it('increments generation', () => {
    expect(useAppStore.getState().generation).toBe(0)
    useAppStore.getState().incrementGeneration()
    expect(useAppStore.getState().generation).toBe(1)
  })
})
