import type { StateCreator } from 'zustand'
import type { AppStore } from '../store'

export type FlowState =
  | { type: 'overview' }
  | { type: 'active'; index: number }
  | { type: 'finished'; prayedCount: number }

type PrayerFlowState = {
  current: FlowState
  lastOverlay: FlowState | null
}

export type PrayerFlowSlice = PrayerFlowState & {
  showOverview: () => void
  startAt: (index: number) => void
  setActiveIndex: (index: number) => void
  finish: (prayedCount: number) => void
}

const initialPrayerFlowState: PrayerFlowState = {
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

export const createPrayerFlowSlice: StateCreator<
  AppStore,
  [],
  [],
  PrayerFlowSlice
> = set => ({
  ...initialPrayerFlowState,

  showOverview: () =>
    set(state => {
      if (state.current.type === 'overview') {
        return {}
      }

      return {
        current: { type: 'overview' },
      }
    }),

  startAt: index =>
    set(state => {
      const nextFlow: FlowState = { type: 'active', index }
      const nextLastOverlay = nextFlow

      if (isSameFlow(state.current, nextFlow) && isSameFlow(state.lastOverlay ?? nextFlow, nextFlow)) {
        return {}
      }

      return {
        current: nextFlow,
        lastOverlay: nextLastOverlay,
      }
    }),

  setActiveIndex: index =>
    set(state => {
      const nextFlow: FlowState = { type: 'active', index }
      const nextLastOverlay = nextFlow

      if (isSameFlow(state.current, nextFlow) && isSameFlow(state.lastOverlay ?? nextFlow, nextFlow)) {
        return {}
      }

      return {
        current: nextFlow,
        lastOverlay: nextLastOverlay,
      }
    }),

  finish: prayedCount =>
    set(state => {
      const nextFlow: FlowState = { type: 'finished', prayedCount }
      const nextLastOverlay = nextFlow

      if (isSameFlow(state.current, nextFlow) && isSameFlow(state.lastOverlay ?? nextFlow, nextFlow)) {
        return {}
      }

      return {
        current: nextFlow,
        lastOverlay: nextLastOverlay,
      }
    }),
})
