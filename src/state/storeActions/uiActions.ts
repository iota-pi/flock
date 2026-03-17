import { generateItemId } from '../../utils'
import type {
  BaseUIMessage,
  DrawerData,
  PushActiveData,
  SetUiPayload,
  UIState,
} from '../ui'
import type { ItemId } from '../items'

export function setUiState(current: UIState, payload: SetUiPayload): UIState {
  return {
    ...current,
    ...payload,
    requests: {
      ...current.requests,
      ...payload.requests,
    },
  }
}

export function startRequestState(current: UIState): UIState {
  return {
    ...current,
    requests: { active: current.requests.active + 1 },
  }
}

export function finishRequestState(current: UIState, error?: string): UIState {
  return {
    ...current,
    requests: { active: Math.max(0, current.requests.active - 1) },
    message: error
      ? { severity: 'error', message: error }
      : current.message,
  }
}

export function setMessageState(current: UIState, payload: BaseUIMessage): UIState {
  return {
    ...current,
    message: {
      severity: payload.severity || 'success',
      message: payload.message,
    },
  }
}

export function toggleSelectedState(current: UIState, itemId: ItemId): UIState {
  const selected = current.selected.includes(itemId)
    ? current.selected.filter(id => id !== itemId)
    : [...current.selected, itemId]
  return { ...current, selected }
}

export function replaceActiveState(current: UIState, payload: Partial<Omit<DrawerData, 'id'>>): UIState {
  const openItems = current.drawers.filter(drawer => drawer.open)
  const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
  const newItem: DrawerData = {
    id: lastItem ? lastItem.id : generateItemId(),
    open: true,
    ...payload,
  }
  const drawers = [...current.drawers]
  if (lastItem) {
    drawers[drawers.indexOf(lastItem)] = newItem
  } else {
    drawers.push(newItem)
  }
  return { ...current, drawers }
}

export function updateActiveState(current: UIState, payload: Partial<Omit<DrawerData, 'id'>>): UIState {
  const openItems = current.drawers.filter(drawer => drawer.open)
  const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
  const newItem: DrawerData = {
    id: generateItemId(),
    open: true,
    ...lastItem,
    ...payload,
  }
  const drawers = [...current.drawers]
  drawers[drawers.length - 1] = newItem
  return { ...current, drawers }
}

export function pushActiveState(current: UIState, payload: PushActiveData): UIState {
  return {
    ...current,
    drawers: [
      ...current.drawers,
      {
        id: generateItemId(),
        open: true,
        ...payload,
      },
    ],
  }
}

export function removeActiveState(current: UIState): UIState {
  return {
    ...current,
    drawers: current.drawers.slice(0, -1),
  }
}

export function clearDrawersState(current: UIState): UIState {
  return {
    ...current,
    drawers: [],
  }
}

export function pruneItemDrawersState(current: UIState, itemIds: ItemId[]): UIState {
  const newDrawers: typeof current.drawers = []
  let modified = false
  for (const drawer of current.drawers) {
    if (drawer.item && itemIds.includes(drawer.item)) {
      modified = true
    } else if (drawer.next && drawer.next.find(item => !itemIds.includes(item))) {
      newDrawers.push({
        ...drawer,
        next: drawer.next.filter(item => !itemIds.includes(item)),
      })
      modified = true
    } else {
      newDrawers.push(drawer)
    }
  }

  return {
    ...current,
    drawers: modified ? newDrawers : current.drawers,
    selected: current.selected.filter(id => !itemIds.includes(id)),
  }
}
