import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../state/items'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'
import { useAutomergeItem } from './useAutomergeItem'

const useDocumentSpy = vi.hoisted(() => vi.fn())

vi.mock('@automerge/automerge-repo-react-hooks', () => ({
  useDocument: useDocumentSpy,
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
    useDocumentSpy.mockReturnValue([undefined, vi.fn()])
  })

  it('passes automerge url to useDocument', () => {
    useDocumentSpy.mockReturnValue([createItem('item-1', 'Alice'), vi.fn()])

    const { result } = renderHook(() => useAutomergeItem('item-1'))

    expect(useDocumentSpy).toHaveBeenCalledWith(toAutomergeUrlFromItemId('item-1'), { suspense: false })
    expect(result.current?.name).toBe('Alice')
  })

  it('rerenders with updated item snapshots', () => {
    useDocumentSpy
      .mockReturnValueOnce([createItem('item-1', 'Alice'), vi.fn()])
      .mockReturnValueOnce([createItem('item-2', 'Bob'), vi.fn()])

    const { rerender, unmount } = renderHook(
      ({ itemId }: { itemId: string }) => useAutomergeItem(itemId),
      {
        initialProps: { itemId: 'item-1' },
      },
    )

    rerender({ itemId: 'item-2' })

    expect(useDocumentSpy).toHaveBeenNthCalledWith(1, toAutomergeUrlFromItemId('item-1'), { suspense: false })
    expect(useDocumentSpy).toHaveBeenNthCalledWith(2, toAutomergeUrlFromItemId('item-2'), { suspense: false })

    unmount()
  })

  it('returns null when document is unavailable', () => {
    useDocumentSpy.mockReturnValue([undefined, vi.fn()])

    const { result } = renderHook(() => useAutomergeItem('item-1'))
    expect(result.current).toBeNull()
  })
})
