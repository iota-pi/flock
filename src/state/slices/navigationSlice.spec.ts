import { createStore } from 'zustand'
import { createNavigationSlice, NavigationSlice } from './navigationSlice'
import { ItemId } from 'src/shared/schemas/items'

describe('navigationSlice (drawer & selection behavior)', () => {
  let store: ReturnType<typeof createStore<NavigationSlice>>

  beforeEach(() => {
    store = createStore<NavigationSlice>()((...a) => ({
      ...createNavigationSlice(...a),
    }))
  })

  it('sets and updates drawer state', () => {
    const personId = 'person-123' as ItemId
    const groupId = 'group-456' as ItemId

    // 1. Open drawer for person
    store.getState().setDrawer({ item: personId })
    expect(store.getState().drawer).not.toBeNull()
    expect(store.getState().drawer?.item).toBe(personId)

    // 2. Switch drawer to group
    store.getState().setDrawer({ item: groupId })
    expect(store.getState().drawer?.item).toBe(groupId)

    // 3. Close drawer
    store.getState().removeDrawer()
    expect(store.getState().drawer).toBeNull()
  })

  it('manages item selections', () => {
    const itemA = 'item-a' as ItemId
    const itemB = 'item-b' as ItemId

    store.getState().toggleSelected(itemA)
    expect(store.getState().selected).toEqual([itemA])

    store.getState().toggleSelected(itemB)
    expect(store.getState().selected).toEqual([itemA, itemB])

    store.getState().toggleSelected(itemA)
    expect(store.getState().selected).toEqual([itemB])
  })
})
