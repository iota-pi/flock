import { vi, describe, it, expect } from 'vitest'
import uiReducer, {
  setUi,
  startRequest,
  finishRequest,
  setMessage,
  toggleSelected,
  pushActive,
  replaceActive,
  updateActive,
  removeActive,
  pruneItems,
  UIState,
} from './ui'
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

describe('ui reducer', () => {
  it('should handle setUi', () => {
    const newState = uiReducer(initialState, setUi({
      darkMode: true,
      requests: { active: 5 }
    }))
    expect(newState.darkMode).toBe(true)
    expect(newState.requests.active).toBe(5)
  })

  it('should handle startRequest', () => {
    const newState = uiReducer(initialState, startRequest())
    expect(newState.requests.active).toBe(1)
  })

  it('should handle finishRequest without error', () => {
    const activeState = { ...initialState, requests: { active: 1 } }
    const newState = uiReducer(activeState, finishRequest())
    expect(newState.requests.active).toBe(0)
    expect(newState.message).toBeNull()
  })

  it('should handle finishRequest with error', () => {
    const activeState = { ...initialState, requests: { active: 1 } }
    const newState = uiReducer(activeState, finishRequest('Failed'))
    expect(newState.requests.active).toBe(0)
    expect(newState.message).toEqual({
      severity: 'error',
      message: 'Failed',
    })
  })

  it('should handle setMessage', () => {
    const newState = uiReducer(initialState, setMessage({ message: 'Success' }))
    expect(newState.message).toEqual({
      severity: 'success',
      message: 'Success',
    })
  })

  it('should handle toggleSelected', () => {
    let state = uiReducer(initialState, toggleSelected('1'))
    expect(state.selected).toContain('1')

    state = uiReducer(state, toggleSelected('2'))
    expect(state.selected).toEqual(['1', '2'])

    state = uiReducer(state, toggleSelected('1'))
    expect(state.selected).toEqual(['2'])
  })

  describe('drawer actions', () => {
    it('should handle pushActive', () => {
      const newState = uiReducer(initialState, pushActive({ item: '1' }))
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0]).toEqual({
        id: 'mock-id',
        open: true,
        item: '1',
      })
    })

    it('should handle replaceActive', () => {
      const stateWithDrawer: UIState = {
        ...initialState,
        drawers: [{ id: 'old-id', open: true, item: '1' }]
      }
      const newState = uiReducer(stateWithDrawer, replaceActive({ item: '2' }))
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0]).toEqual({
        id: 'old-id',
        open: true,
        item: '2',
      })
    })

    it('should handle updateActive', () => {
      const stateWithDrawer: UIState = {
        ...initialState,
        drawers: [{ id: 'old-id', open: true, item: '1', praying: false }]
      }
      const newState = uiReducer(stateWithDrawer, updateActive({ praying: true }))
      expect(newState.drawers).toHaveLength(1)
      expect(newState.drawers[0]).toEqual({
        id: 'old-id', // ID should be preserved
        open: true,
        item: '1',
        praying: true,
      })
    })

    it('should handle removeActive', () => {
      const stateWithDrawer: UIState = {
        ...initialState,
        drawers: [{ id: '1', open: true, item: '1' }]
      }
      const newState = uiReducer(stateWithDrawer, removeActive())
      expect(newState.drawers).toHaveLength(0)
    })
  })

  describe('pruneItems', () => {
    it('should remove pruned items from drawers', () => {
      const state: UIState = {
        ...initialState,
        drawers: [
          { id: '1', open: true, item: 'keep' },
          { id: '2', open: true, item: 'delete' },
        ],
        selected: ['keep', 'delete']
      }

      const newState = uiReducer(state, pruneItems(['delete']))
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
      const newState = uiReducer(state, pruneItems(['3']))
      expect(newState.drawers[0].next).toEqual(['2', '4'])
    })
  })
})
