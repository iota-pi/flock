import { act, renderHook } from '@testing-library/react'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '../state/items'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { useAutomergeItems } from './useAutomerge'

type Listener = () => void

const {
  useDocumentMock,
  useRepoMock,
} = vi.hoisted(() => ({
  useDocumentMock: vi.fn(),
  useRepoMock: vi.fn(),
}))

vi.mock('@automerge/automerge-repo-react-hooks', () => ({
  useDocument: useDocumentMock,
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

describe('useAutomergeItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips non-ready handles instead of throwing', () => {
    const itemId = 'item-1'
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl

    useDocumentMock.mockReturnValue([
      {
        itemIds: [itemId],
      },
      vi.fn(),
    ])

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
        [itemUrl, new MockDocHandle(false, false, buildPersonDoc(itemId, 'Alpha'))],
      ])),
    )

    const { result } = renderHook(() => useAutomergeItems<Item>())

    expect(result.current).toEqual([])
  })

  it('normalizes missing ids and updates when handle emits changes', () => {
    const itemId = 'item-2'
    const itemUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl

    const initialDoc = buildPersonDoc(itemId, 'Before')
    delete initialDoc.id

    const handle = new MockDocHandle(true, false, initialDoc)

    useDocumentMock.mockReturnValue([
      {
        itemIds: [itemId],
      },
      vi.fn(),
    ])

    useRepoMock.mockReturnValue(
      createMockRepo(new Map([
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

    expect(result.current).toHaveLength(1)
    expect(result.current[0]?.name).toBe('After')
  })
})