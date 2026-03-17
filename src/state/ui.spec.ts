import { vi, describe, it, expect } from 'vitest'
import {
  finishRequestState,
  pruneItemDrawersState,
  pushActiveState,
  removeActiveState,
  replaceActiveState,
  setMessageState,
  setUiState,
  startRequestState,
  toggleSelectedState,
  updateActiveState,
} from './storeActions/uiActions'
import { UIState } from './ui'
import { DEFAULT_FILTER_CRITERIA } from '../utils/customFilter'

// Mock generateItemId
vi.mock('../utils', () => ({
  generateItemId: vi.fn().mockReturnValue('mock-id'),
}))

const initialState: UIState = {
  darkMode: null,
  drawers: [],
  filters: DEFAULT_FILTER_CRITERIA,
  message: null,
  requests: {
    active: 0,
  },
  selected: [],
  justCreatedAccount: false,
}

describe('ui state transforms', () => {
  it('should handle setUiState', () => {
    const newState = setUiState(initialState, {
      darkMode: true,
      requests: { active: 5 }
    })
    expect(newState.darkMode).toBe(true)
    expect(newState.requests.active).toBe(5)
  })

  it('should handle startRequestState', () => {
    const newState = startRequestState(initialState)
    expect(newState.requests.active).toBe(1)
  })

  it('should handle finishRequestState without error', () => {
    const activeState = { ...initialState, requests: { active: 1 } }
    const newState = finishRequestState(activeState)
    expect(newState.requests.active).toBe(0)
    expect(newState.message).toBeNull()
  })

  it('should handle finishRequestState with error', () => {
    const activeState = { ...initialState, requests: { active: 1 } }
    const newState = finishRequestState(activeState, 'Failed')
    expect(newState.requests.active).toBe(0)
    expect(newState.message).toEqual({
      severity: 'error',
      message: 'Failed',
    })
  })

  it('should handle setMessageState', () => {
    const newState = setMessageState(initialState, { message: 'Success' })
    expect(newState.message).toEqual({
      severity: 'success',
      message: 'Success',
    })
  })

  it('should handle toggleSelectedState', () => {
    let state = toggleSelectedState(initialState, '1')
    expect(state.selected).toContain('1')

    state = toggleSelectedState(state, '2')
    expect(state.selected).toEqual(['1', '2'])

    state = toggleSelectedState(state, '1')
    expect(state.selected).toEqual(['2'])
  })

  describe('drawer actions', () => {
    it('should handle pushActiveState', () => {
      const newState = pushActiveState(initialState, { item: '1' })
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0]).toEqual({
        id: 'mock-id',
        open: true,
        item: '1',
      })
    })

    it('should handle replaceActiveState', () => {
      const stateWithDrawer: UIState = {
        ...initialState,
        drawers: [{ id: 'old-id', open: true, item: '1' }]
      }
      const newState = replaceActiveState(stateWithDrawer, { item: '2' })
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0]).toEqual({
        id: 'old-id',
        open: true,
        item: '2',
      })
    })

    it('should handle updateActiveState', () => {
      const stateWithDrawer: UIState = {
        ...initialState,
        drawers: [{ id: 'old-id', open: true, item: '1', praying: false }]
      }
      const newState = updateActiveState(stateWithDrawer, { praying: true })
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0]).toEqual({
        id: 'old-id', // ID should be preserved
        open: true,
        item: '1',
        praying: true,
      })
    })

    it('should handle removeActiveState', () => {
      const stateWithDrawer: UIState = {
        ...initialState,
        drawers: [{ id: '1', open: true, item: '1' }]
      }
      const newState = removeActiveState(stateWithDrawer)
      expect(newState.drawers).toHaveLength(0)
    })
  })

  describe('pruneItemDrawersState', () => {
    it('should remove pruned items from drawers', () => {
      const state: UIState = {
        ...initialState,
        drawers: [
          { id: '1', open: true, item: 'keep' },
          { id: '2', open: true, item: 'delete' },
        ],
        selected: ['keep', 'delete']
      }

      const newState = pruneItemDrawersState(state, ['delete'])
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0].item).toBe('keep')
      expect(newState.selected).toEqual(['keep'])
    })

    it('should remove pruned items from next lists in drawers', () => {
      const state: UIState = {
        ...initialState,
        drawers: [
          { id: '1', open: true, item: '1', next: ['2', '3', '4'] },
        ]
      }
      const newState = pruneItemDrawersState(state, ['3'])
      expect(newState.drawers[0].next).toEqual(['2', '4'])
    })
  })
})
