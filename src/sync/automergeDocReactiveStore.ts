import { createStore } from 'zustand/vanilla'

type AutomergeDocReactiveState = {
  itemsRevision: number
  metadataRevision: number
  itemRevisions: Record<string, number>
}

const automergeDocReactiveStore = createStore<AutomergeDocReactiveState>(() => ({
  itemsRevision: 0,
  metadataRevision: 0,
  itemRevisions: {},
}))

function bumpItemsRevision(): void {
  automergeDocReactiveStore.setState(state => ({
    ...state,
    itemsRevision: state.itemsRevision + 1,
  }))
}

export function emitAutomergeItemRevision(itemId: string): void {
  automergeDocReactiveStore.setState(state => ({
    ...state,
    itemRevisions: {
      ...state.itemRevisions,
      [itemId]: (state.itemRevisions[itemId] || 0) + 1,
    },
  }))
}

export function removeAutomergeItemRevision(itemId: string): void {
  automergeDocReactiveStore.setState(state => {
    if (!(itemId in state.itemRevisions)) {
      return state
    }

    const nextItemRevisions = { ...state.itemRevisions }
    delete nextItemRevisions[itemId]

    return {
      ...state,
      itemRevisions: nextItemRevisions,
    }
  })
}

export function clearAutomergeItemRevisions(): void {
  automergeDocReactiveStore.setState(state => {
    if (Object.keys(state.itemRevisions).length === 0) {
      return state
    }

    return {
      ...state,
      itemRevisions: {},
    }
  })
}

export function emitAutomergeItemsRevision(): void {
  bumpItemsRevision()
}

export function emitAutomergeMetadataRevision(): void {
  automergeDocReactiveStore.setState(state => ({
    ...state,
    metadataRevision: state.metadataRevision + 1,
  }))
}

export function subscribeAutomergeItemsRevision(listener: () => void): () => void {
  let previousRevision = automergeDocReactiveStore.getState().itemsRevision

  return automergeDocReactiveStore.subscribe(state => {
    if (state.itemsRevision === previousRevision) {
      return
    }

    previousRevision = state.itemsRevision
    listener()
  })
}

export function subscribeAutomergeItemRevision(itemId: string, listener: () => void): () => void {
  let previousRevision = automergeDocReactiveStore.getState().itemRevisions[itemId] || 0

  return automergeDocReactiveStore.subscribe(state => {
    const nextRevision = state.itemRevisions[itemId] || 0
    if (nextRevision === previousRevision) {
      return
    }

    previousRevision = nextRevision
    listener()
  })
}

export function subscribeAutomergeMetadataRevision(listener: () => void): () => void {
  let previousRevision = automergeDocReactiveStore.getState().metadataRevision

  return automergeDocReactiveStore.subscribe(state => {
    if (state.metadataRevision === previousRevision) {
      return
    }

    previousRevision = state.metadataRevision
    listener()
  })
}