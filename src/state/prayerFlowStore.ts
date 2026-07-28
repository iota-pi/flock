import { create } from 'zustand'

export type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }

type PrayerFlowState = {
  current: FlowState
  lastOverlay: FlowState | null
}

type PrayerFlowActions = {
  showOverview: () => void
  startAt: (index: number) => void
  setActiveIndex: (index: number) => void
  finish: (prayedCount: number) => void
}

export type PrayerFlowStore = PrayerFlowState & PrayerFlowActions

const PRAYER_FLOW_INITIAL_STATE: PrayerFlowState = {
  current: { type: 'overview' },
  lastOverlay: null,
}

function isSameFlow(a: FlowState, b: FlowState): boolean {
  if (a.type !== b.type) {
    return false
  }

  if (a.type === 'active' && b.type === 'active') {
    return a.index === b.index
  }

  if (a.type === 'finished' && b.type === 'finished') {
    return a.prayedCount === b.prayedCount
  }

  return true
}

export const usePrayerFlowStore = create<PrayerFlowStore>(set => ({
  ...PRAYER_FLOW_INITIAL_STATE,

  showOverview: () => set(state => {
    if (state.current.type === 'overview') {
      return state
    }

    return {
      ...state,
      current: { type: 'overview' },
    }
  }),

  startAt: index => set(state => {
    const nextFlow: FlowState = { type: 'active', index }
    const nextLastOverlay = nextFlow

    if (isSameFlow(state.current, nextFlow) && isSameFlow(state.lastOverlay ?? nextFlow, nextFlow)) {
      return state
    }

    return {
      ...state,
      current: nextFlow,
      lastOverlay: nextLastOverlay,
    }
  }),

  setActiveIndex: index => set(state => {
    const nextFlow: FlowState = { type: 'active', index }
    const nextLastOverlay = nextFlow

    if (isSameFlow(state.current, nextFlow) && isSameFlow(state.lastOverlay ?? nextFlow, nextFlow)) {
      return state
    }

    return {
      ...state,
      current: nextFlow,
      lastOverlay: nextLastOverlay,
    }
  }),

  finish: prayedCount => set(state => {
    const nextFlow: FlowState = { type: 'finished', prayedCount }
    const nextLastOverlay = nextFlow

    if (isSameFlow(state.current, nextFlow) && isSameFlow(state.lastOverlay ?? nextFlow, nextFlow)) {
      return state
    }

    return {
      ...state,
      current: nextFlow,
      lastOverlay: nextLastOverlay,
    }
  }),
}))
