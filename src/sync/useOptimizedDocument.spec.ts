import { act, renderHook } from '@testing-library/react'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOptimizedDocument } from './useOptimizedDocument'

type Listener = () => void

type MockDoc = {
  value: number
  stableLabel: string
}

const {
  useRepoMock,
} = vi.hoisted(() => ({
  useRepoMock: vi.fn(),
}))

vi.mock('@automerge/automerge-repo-react-hooks', () => ({
  useRepo: useRepoMock,
}))

class MockDocHandle<TDoc extends object> {
  private readonly listeners = new Map<string, Set<Listener>>()

  public constructor(
    private ready: boolean,
    private unavailable: boolean,
    private currentDoc: TDoc | null,
  ) {}

  public isReady(): boolean {
    return this.ready
  }

  public isUnavailable(): boolean {
    return this.unavailable
  }

  public doc(): TDoc {
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

  public change(changeFn: (draft: TDoc) => void): void {
    if (!this.currentDoc) {
      return
    }

    const nextDoc = { ...(this.currentDoc as Record<string, unknown>) } as TDoc
    changeFn(nextDoc)
    this.currentDoc = nextDoc
    this.emit('change')
  }

  public setDoc(nextDoc: TDoc): void {
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

function createMockRepo(handleByUrl: Map<AutomergeUrl, MockDocHandle<MockDoc>>) {
  return {
    findWithProgress: (documentUrl: AutomergeUrl) => ({
      handle: handleByUrl.get(documentUrl),
    }),
  }
}

describe('useOptimizedDocument', () => {
  const documentUrl = 'automerge:test-doc' as AutomergeUrl

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces multiple change events into a single snapshot update', () => {
    const handle = new MockDocHandle<MockDoc>(true, false, { value: 1, stableLabel: 'same' })
    useRepoMock.mockReturnValue(createMockRepo(new Map([[documentUrl, handle]])))

    const projectSnapshot = vi.fn((doc: MockDoc | undefined): number => doc?.value || 0)

    const { result } = renderHook(() => {
      const [snapshot] = useOptimizedDocument<MockDoc, number>(documentUrl, projectSnapshot, 0)
      return snapshot
    })

    expect(result.current).toBe(1)

    projectSnapshot.mockClear()
    act(() => {
      handle.setDoc({ value: 2, stableLabel: 'same' })
      handle.emit('change')
      handle.emit('change')
      handle.emit('change')
      handle.emit('change')
      handle.emit('change')
    })

    expect(result.current).toBe(1)

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(result.current).toBe(2)
    expect(projectSnapshot).toHaveBeenCalledTimes(1)
  })

  it('returns the same snapshot reference when projected values stay equal', () => {
    const handle = new MockDocHandle<MockDoc>(true, false, { value: 1, stableLabel: 'alpha' })
    useRepoMock.mockReturnValue(createMockRepo(new Map([[documentUrl, handle]])))

    const { result } = renderHook(() => {
      const [snapshot] = useOptimizedDocument<MockDoc, { stableLabel: string }>(
        documentUrl,
        doc => ({ stableLabel: doc?.stableLabel || 'none' }),
        { stableLabel: 'none' },
      )

      return snapshot
    })

    const firstSnapshot = result.current

    act(() => {
      handle.setDoc({ value: 2, stableLabel: 'alpha' })
      handle.emit('change')
    })

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(result.current).toBe(firstSnapshot)
  })

  it('clears pending debounce timeouts during teardown', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    const handle = new MockDocHandle<MockDoc>(true, false, { value: 1, stableLabel: 'same' })
    useRepoMock.mockReturnValue(createMockRepo(new Map([[documentUrl, handle]])))

    const { unmount } = renderHook(() => {
      const [snapshot] = useOptimizedDocument<MockDoc, number>(
        documentUrl,
        doc => doc?.value || 0,
        0,
      )

      return snapshot
    })

    act(() => {
      handle.emit('change')
    })

    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })
})
