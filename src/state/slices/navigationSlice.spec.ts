import { useAppStore } from 'src/state/store'
import { ItemId } from 'src/shared/schemas/items'

describe('navigationSlice (drawer & selection behavior)', () => {
  beforeEach(() => {
    useAppStore.getState().removeDrawer()
    useAppStore.getState().setSelected([])
  })

  it('sets and updates drawer state', () => {
    const personId = 'person-123' as ItemId
    const groupId = 'group-456' as ItemId

    // 1. Open drawer for person
    useAppStore.getState().setDrawer({ item: personId })
    expect(useAppStore.getState().drawer).not.toBeNull()
    expect(useAppStore.getState().drawer?.item).toBe(personId)

    // 2. Switch drawer to group
    useAppStore.getState().setDrawer({ item: groupId })
    expect(useAppStore.getState().drawer?.item).toBe(groupId)

    // 3. Close drawer
    useAppStore.getState().removeDrawer()
    expect(useAppStore.getState().drawer).toBeNull()
  })

  it('manages item selections', () => {
    const itemA = 'item-a' as ItemId
    const itemB = 'item-b' as ItemId

    useAppStore.getState().toggleSelected(itemA)
    expect(useAppStore.getState().selected).toEqual([itemA])

    useAppStore.getState().toggleSelected(itemB)
    expect(useAppStore.getState().selected).toEqual([itemA, itemB])

    useAppStore.getState().toggleSelected(itemA)
    expect(useAppStore.getState().selected).toEqual([itemB])
  })
})
