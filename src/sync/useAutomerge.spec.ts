import { act, renderHook } from '@testing-library/react'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Item } from '../state/items'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import {
  useAutomergeItemSelector,
  useAutomergeItems,
  useAutomergeItemsById,
  useAutomergeMetadataSnapshot,
  clearParsedItemCache,
} from './useAutomerge'

type Listener = () => void

const {
  useRepoMock,
} = vi.hoisted(() => ({
  useRepoMock: vi.fn(),
}))

vi.mock('@automerge/automerge-repo-react-hooks', () => ({
  useRepo: useRepoMock,
}))

class MockDocHandle {
  private readonly listeners = new Map<string, Set<Listener>>()

  public constructor(
    private ready: boolean,
    private unavailable: boolean,
    private currentDoc: Record<string, unknown> | null,
  ) {}

  public isReady(): boolean {
    return this.ready
  }

  public isUnavailable(): boolean {
    return this.unavailable
  }

  public doc(): Record<string, unknown> {
    if (!this.ready || this.unavailable || !this.currentDoc) {
      throw new Error('DocHandle is not ready')
    }

    return this.currentDoc
  }

  public on(event: string, listener: Listener): void {
    const existing = this.listeners.get(event)
    if (existing) {
      existing.add(listener)
      return
    }

    this.listeners.set(event, new Set([listener]))
  }

  public removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener)
  }

  public whenReady(): Promise<void> {
    return Promise.resolve()
  }

  public setDoc(nextDoc: Record<string, unknown>): void {
    this.currentDoc = nextDoc
  }

  public emit(event: string): void {
    const listeners = this.listeners.get(event)
    if (!listeners) {
      return
    }

    for (const listener of listeners) {
      listener()
    }
  }

  public listenerCount(event: string): number {
    return this.listeners.get(event)?.size || 0
  }
}

function buildPersonDoc(itemId: string, name: string): Record<string, unknown> {
  return {
    archived: false,
    created: Date.now(),
    description: '',
    id: itemId,
    name,
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
    type: 'person',
  }
}

function createMockRepo(handleByUrl: Map<AutomergeUrl, MockDocHandle>) {
  return {
    findWithProgress: (documentUrl: AutomergeUrl) => ({
      handle: handleByUrl.get(documentUrl),
    }),
  }
}

function buildIndexDoc(itemIds: string[]): Record<string, unknown> {
  return {
    itemIds,
  }
}

describe('useAutomergeItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    clearParsedItemCache()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips non-ready handles instead of throwing', () => {
    const itemId = 'item-1'
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, buildIndexDoc([itemId]))],
        [itemUrl, new MockDocHandle(false, false, buildPersonDoc(itemId, 'Alpha'))],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItems<Item>())

    expect(result.current).toEqual([])
  })

  it('normalizes missing ids and updates when handle emits changes', () => {
    const itemId = 'item-2'
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl

    const initialDoc = buildPersonDoc(itemId, 'Before')
    delete initialDoc.id

    const handle = new MockDocHandle(true, false, initialDoc)

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, buildIndexDoc([itemId]))],
        [itemUrl, handle],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItems<Item>())

    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.id).toBe(itemId)
    expect(result.current[0]?.name).toBe('Before')

    act(() => {
      handle.setDoc(buildPersonDoc(itemId, 'After'))
      handle.emit('change')
    })

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.name).toBe('After')
  })

  it('keeps stable item array reference when events do not change parsed values', () => {
    const itemId = 'item-3'
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl

    const handle = new MockDocHandle(true, false, buildPersonDoc(itemId, 'Stable'))

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, buildIndexDoc([itemId]))],
        [itemUrl, handle],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItems<Item>())
    const firstResult = result.current

    act(() => {
      handle.emit('heads-changed')
    })

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(result.current).toBe(firstResult)
  })

  it('parses only the changed item doc when one item updates', () => {
    const itemIds = ['item-11', 'item-12', 'item-13', 'item-14', 'item-15']
    const targetItemId = 'item-13'

    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const handlesByUrl = new Map<AutomergeUrl, MockDocHandle>()
    handlesByUrl.set(indexUrl, new MockDocHandle(true, false, buildIndexDoc(itemIds)))

    let targetHandle: MockDocHandle | null = null
    for (const itemId of itemIds) {
      const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
      const itemHandle = new MockDocHandle(true, false, buildPersonDoc(itemId, `Name-${itemId}`))
      handlesByUrl.set(itemUrl, itemHandle)

      if (itemId === targetItemId) {
        targetHandle = itemHandle
      }
    }

    const safeParse = vi.fn((value: unknown) => ({
      success: true as const,
      data: value as Item,
    }))
    const schema = { safeParse } as unknown as z.ZodType<Item>

    useRepoMock.mockReturnValue(createMockRepo(handlesByUrl))

    const { result } = renderHook(() => useAutomergeItems<Item>(schema))
    expect(result.current).toHaveLength(itemIds.length)

    safeParse.mockClear()
    act(() => {
      targetHandle?.setDoc(buildPersonDoc(targetItemId, 'Name-Updated'))
      targetHandle?.emit('change')
    })

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(result.current.find((entry: Item) => entry.id === targetItemId)?.name).toBe('Name-Updated')
    expect(safeParse).toHaveBeenCalledTimes(1)
  })

  it('keeps unchanged item object references stable on unrelated updates', () => {
    const itemA = 'item-a'
    const itemB = 'item-b'
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const itemAUrl = toAutomergeUrlFromItemId(itemA) as AutomergeUrl
    const itemBUrl = toAutomergeUrlFromItemId(itemB) as AutomergeUrl

    const handleA = new MockDocHandle(true, false, buildPersonDoc(itemA, 'Alpha'))
    const handleB = new MockDocHandle(true, false, buildPersonDoc(itemB, 'Beta'))

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, buildIndexDoc([itemA, itemB]))],
        [itemAUrl, handleA],
        [itemBUrl, handleB],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItems<Item>())
    const initialItemB = result.current.find((entry: Item) => entry.id === itemB)

    act(() => {
      handleA.setDoc(buildPersonDoc(itemA, 'Alpha-Updated'))
      handleA.emit('change')
    })

    act(() => {
      vi.advanceTimersByTime(60)
    })

    const updatedItemB = result.current.find((entry: Item) => entry.id === itemB)
    expect(updatedItemB).toBe(initialItemB)
  })

  it('attaches and detaches item listeners when index ids change', () => {
    const itemA = 'item-sub-a'
    const itemB = 'item-sub-b'

    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const itemAUrl = toAutomergeUrlFromItemId(itemA) as AutomergeUrl
    const itemBUrl = toAutomergeUrlFromItemId(itemB) as AutomergeUrl

    const indexHandle = new MockDocHandle(true, false, buildIndexDoc([itemA]))
    const handleA = new MockDocHandle(true, false, buildPersonDoc(itemA, 'A'))
    const handleB = new MockDocHandle(true, false, buildPersonDoc(itemB, 'B'))

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, indexHandle],
        [itemAUrl, handleA],
        [itemBUrl, handleB],
      ])),
    )

    renderHook(() => useAutomergeItems<Item>())

    expect(handleA.listenerCount('change')).toBeGreaterThan(0)
    expect(handleB.listenerCount('change')).toBe(0)

    act(() => {
      indexHandle.setDoc(buildIndexDoc([itemA, itemB]))
      indexHandle.emit('change')
    })

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(handleB.listenerCount('change')).toBeGreaterThan(0)

    act(() => {
      indexHandle.setDoc(buildIndexDoc([itemB]))
      indexHandle.emit('change')
    })

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(handleA.listenerCount('change')).toBe(0)
    expect(handleB.listenerCount('change')).toBeGreaterThan(0)
  })

  it('loads requested docs without reading the index document', () => {
    const targetItemId = 'item-targeted'
    const targetItemUrl = toAutomergeUrlFromItemId(targetItemId) as AutomergeUrl
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl

    const repo = createMockRepo(new Map([
      [targetItemUrl, new MockDocHandle(true, false, buildPersonDoc(targetItemId, 'Targeted'))],
    ]))
    const findWithProgressSpy = vi.spyOn(repo, 'findWithProgress')

    useRepoMock.mockReturnValue(repo)

    const { result } = renderHook(() => useAutomergeItemsById<Item>([targetItemId]))

    expect(result.current.map(item => item.id)).toEqual([targetItemId])
    expect(findWithProgressSpy).not.toHaveBeenCalledWith(indexUrl)
  })

  it('returns an explicit error item when parsing fails', () => {
    const itemId = 'item-bad'
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, buildIndexDoc([itemId]))],
        [itemUrl, new MockDocHandle(true, false, {
          id: itemId,
          name: 'Broken',
          notes: 'invalid',
          type: 'person',
        })],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItems<Item>())

    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.type).toBe('error')
    expect(result.current[0]?.id).toBe(itemId)
  })

  it('supports granular selectors for item primitives', () => {
    const itemId = 'item-selector'
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
    const handle = new MockDocHandle(true, false, buildPersonDoc(itemId, 'Selector Name'))

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [itemUrl, handle],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItemSelector(
      itemId,
      item => item?.name || '',
      '',
    ))

    expect(result.current).toBe('Selector Name')

    act(() => {
      handle.setDoc({
        ...buildPersonDoc(itemId, 'Selector Name'),
        description: 'Description changed',
      })
      handle.emit('change')
    })

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(result.current).toBe('Selector Name')
  })
})

describe('useAutomergeMetadataSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads metadata from the index document', () => {
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, {
          metadata: {
            prayerGoal: 3,
          },
        })],
      ])),
    )

    const { result } = renderHook(() => useAutomergeMetadataSnapshot())
    expect(result.current.prayerGoal).toBe(3)
  })

  it('returns empty metadata for invalid metadata payloads', () => {
    const indexUrl = toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [indexUrl, new MockDocHandle(true, false, {
          metadata: {
            prayerGoal: 'bad-value',
          },
        })],
      ])),
    )

    const { result } = renderHook(() => useAutomergeMetadataSnapshot())
    expect(result.current).toEqual({})
  })
})
