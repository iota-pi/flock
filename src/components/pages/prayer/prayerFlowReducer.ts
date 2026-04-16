import type { DirtyItem, Item } from '../../../state/items'

export type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }

export type PrayerFlowState = {
  current: FlowState
  lastOverlay: FlowState | null
  localItems: DirtyItem<Item>[]
}

export type PrayerFlowAction =
  | { type: 'show-overview' }
  | { type: 'start-at'; index: number }
  | { type: 'set-active-index'; index: number }
  | { type: 'finish'; prayedCount: number }
  | { type: 'set-local-items'; items: DirtyItem<Item>[] }
  | { type: 'update-local-items'; updater: (prev: DirtyItem<Item>[]) => DirtyItem<Item>[] }

export const PRAYER_FLOW_INITIAL_STATE: PrayerFlowState = {
  current: { type: 'overview' },
  lastOverlay: null,
  localItems: [],
}

function getNextFlowState(current: FlowState, action: PrayerFlowAction): FlowState {
  if (action.type === 'show-overview') {
    return { type: 'overview' }
  }

  if (action.type === 'start-at' || action.type === 'set-active-index') {
    return { type: 'active', index: action.index }
  }

  if (action.type === 'finish') {
    return { type: 'finished', prayedCount: action.prayedCount }
  }

  return current
}

export function prayerFlowReducer(state: PrayerFlowState, action: PrayerFlowAction): PrayerFlowState {
  if (action.type === 'set-local-items') {
    if (action.items === state.localItems) {
      return state
    }

    return {
      ...state,
      localItems: action.items,
    }
  }

  if (action.type === 'update-local-items') {
    const nextItems = action.updater(state.localItems)
    if (nextItems === state.localItems) {
      return state
    }

    return {
      ...state,
      localItems: nextItems,
    }
  }

  const nextFlow = getNextFlowState(state.current, action)
  const nextLastOverlay = nextFlow.type === 'overview' ? state.lastOverlay : nextFlow

  if (
    nextFlow === state.current
    && nextLastOverlay === state.lastOverlay
  ) {
    return state
  }

  return {
    current: nextFlow,
    lastOverlay: nextLastOverlay,
  }
}