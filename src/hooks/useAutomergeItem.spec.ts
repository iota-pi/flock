import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../state/items'
import { useAutomergeItem } from './useAutomergeItem'

const getAutomergeItemSpy = vi.hoisted(() => vi.fn())
const subscribeAutomergeItemSpy = vi.hoisted(() => vi.fn())

vi.mock('../sync/automergeDocStore', () => ({
  getAutomergeItem: getAutomergeItemSpy,
  subscribeAutomergeItem: subscribeAutomergeItemSpy,
}))

function createItem(id: string, name: string): Item {
  return {
    id,
    type: 'person',
    name,
  } as unknown as Item
}

describe('useAutomergeItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAutomergeItemSpy.mockReturnValue(null)
  })

  it('does not resubscribe when rerendered with the same item id', () => {
    const unsubscribe = vi.fn()
    subscribeAutomergeItemSpy.mockReturnValue(unsubscribe)
    getAutomergeItemSpy.mockReturnValue(createItem('item-1', 'Alice'))

    const { rerender, unmount } = renderHook(
      ({ itemId }: { itemId: string }) => useAutomergeItem(itemId),
      {
        initialProps: { itemId: 'item-1' },
      },
    )

    expect(subscribeAutomergeItemSpy).toHaveBeenCalledTimes(1)
    expect(subscribeAutomergeItemSpy).toHaveBeenCalledWith('item-1', expect.any(Function))

    rerender({ itemId: 'item-1' })

    expect(subscribeAutomergeItemSpy).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('resubscribes when the item id changes', () => {
    const unsubscribeItem1 = vi.fn()
    const unsubscribeItem2 = vi.fn()

    subscribeAutomergeItemSpy
      .mockReturnValueOnce(unsubscribeItem1)
      .mockReturnValueOnce(unsubscribeItem2)

    const { rerender, unmount } = renderHook(
      ({ itemId }: { itemId: string }) => useAutomergeItem(itemId),
      {
        initialProps: { itemId: 'item-1' },
      },
    )

    rerender({ itemId: 'item-2' })

    expect(subscribeAutomergeItemSpy).toHaveBeenCalledTimes(2)
    expect(subscribeAutomergeItemSpy).toHaveBeenNthCalledWith(1, 'item-1', expect.any(Function))
    expect(subscribeAutomergeItemSpy).toHaveBeenNthCalledWith(2, 'item-2', expect.any(Function))
    expect(unsubscribeItem1).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribeItem2).toHaveBeenCalledTimes(1)
  })

  it('refreshes snapshot when the store notifies a change', () => {
    let onStoreChange: (() => void) | undefined
    let currentItem: Item | null = createItem('item-1', 'Alice')

    subscribeAutomergeItemSpy.mockImplementation((_: string, listener: () => void) => {
      onStoreChange = listener
      return () => undefined
    })

    getAutomergeItemSpy.mockImplementation(() => currentItem)

    const { result } = renderHook(() => useAutomergeItem('item-1'))

    expect(result.current?.name).toBe('Alice')

    act(() => {
      currentItem = createItem('item-1', 'Bob')
      onStoreChange?.()
    })

    expect(result.current?.name).toBe('Bob')
  })
})
