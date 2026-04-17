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
  | { type: 'clear-local-items' }
  | {
    type: 'edit-item'
    index: number
    changes: Partial<DirtyItem<Item>>
    markDirty?: boolean
  }
  | {
    type: 'replace-item'
    index: number
    item: DirtyItem<Item>
  }
  | {
    type: 'record-prayer'
    index: number
    timestamp: number
  }

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

function isSameCalendarDay(timeA: number, timeB: number): boolean {
  const a = new Date(timeA)
  const b = new Date(timeB)

  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  )
}

export function applyPrayerToItem(item: DirtyItem<Item>, timestamp: number): {
  addedPrayer: boolean
  item: DirtyItem<Item>
} {
  const alreadyPrayedToday = item.prayedFor.some(prayedAt => isSameCalendarDay(prayedAt, timestamp))
  if (alreadyPrayedToday) {
    return {
      addedPrayer: false,
      item,
    }
  }

  return {
    addedPrayer: true,
    item: {
      ...item,
      dirty: true,
      prayedFor: [...item.prayedFor, timestamp],
    },
  }
}

function replaceLocalItemAtIndex(
  items: DirtyItem<Item>[],
  index: number,
  nextItem: DirtyItem<Item>,
): DirtyItem<Item>[] {
  if (!items[index]) {
    return items
  }

  const nextItems = [...items]
  nextItems[index] = nextItem
  return nextItems
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

  if (action.type === 'clear-local-items') {
    if (state.localItems.length === 0) {
      return state
    }

    return {
      ...state,
      localItems: [],
    }
  }

  if (action.type === 'edit-item') {
    const currentItem = state.localItems[action.index]
    if (!currentItem) {
      return state
    }

    if (Object.keys(action.changes).length === 0 && !action.markDirty) {
      return state
    }

    const nextItem = {
      ...currentItem,
      ...action.changes,
      dirty: action.markDirty ? true : (action.changes.dirty ?? currentItem.dirty),
    } as DirtyItem<Item>

    return {
      ...state,
      localItems: replaceLocalItemAtIndex(state.localItems, action.index, nextItem),
    }
  }

  if (action.type === 'replace-item') {
    if (!state.localItems[action.index] || state.localItems[action.index] === action.item) {
      return state
    }

    return {
      ...state,
      localItems: replaceLocalItemAtIndex(state.localItems, action.index, action.item),
    }
  }

  if (action.type === 'record-prayer') {
    const currentItem = state.localItems[action.index]
    if (!currentItem) {
      return state
    }

    const prayerUpdate = applyPrayerToItem(currentItem, action.timestamp)
    if (prayerUpdate.item === currentItem) {
      return state
    }

    return {
      ...state,
      localItems: replaceLocalItemAtIndex(state.localItems, action.index, prayerUpdate.item),
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
    ...state,
    current: nextFlow,
    lastOverlay: nextLastOverlay,
  }
}