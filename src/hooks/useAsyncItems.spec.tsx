import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useAsyncItems } from './useAsyncItems'

const mocks = vi.hoisted(() => ({
  processItemsWithWorker: vi.fn(),
}))

vi.mock('../workers/itemWorkerManager', () => ({
  processItemsWithWorker: mocks.processItemsWithWorker,
}))

describe('useAsyncItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.processItemsWithWorker.mockResolvedValue({
      results: [{ id: '1', type: 'person', name: 'Alice', archived: false }],
      totalApplicable: 1,
      archivedCount: 0,
    })
  })

  it('dispatches one worker request on initial mount', async () => {
    const items = [{ id: '1', type: 'person', name: 'Alice', archived: false }]
    const filters = [{ type: 'name', baseOperator: 'contains', inverse: false, operator: 'contains', value: 'Ali' }]
    const sortCriteria = [{ type: 'name', reverse: false }]

    renderHook(() => useAsyncItems({
      items: items as any,
      filters: filters as any,
      sortCriteria: sortCriteria as any,
      showArchived: false,
    }))

    await waitFor(() => {
      expect(mocks.processItemsWithWorker).toHaveBeenCalledTimes(1)
    })

    expect(mocks.processItemsWithWorker).toHaveBeenCalledWith({
      items,
      filters,
      sortCriteria,
      showArchived: false,
    })
  })

  it('does not re-dispatch when deep-equal filters are re-instantiated', async () => {
    const items = [{ id: '1', type: 'person', name: 'Alice', archived: false }]
    const sortCriteria = [{ type: 'name', reverse: false }]

    const { rerender } = renderHook(
      ({ filters }) => useAsyncItems({
        items: items as any,
        filters: filters as any,
        sortCriteria: sortCriteria as any,
        showArchived: false,
      }),
      {
        initialProps: {
          filters: [{ type: 'name', baseOperator: 'contains', inverse: false, operator: 'contains', value: 'Group' }],
        },
      },
    )

    await waitFor(() => {
      expect(mocks.processItemsWithWorker).toHaveBeenCalledTimes(1)
    })

    rerender({
      filters: [{ type: 'name', baseOperator: 'contains', inverse: false, operator: 'contains', value: 'Group' }],
    })

    await waitFor(() => {
      expect(mocks.processItemsWithWorker).toHaveBeenCalledTimes(1)
    })
  })

  it('re-dispatches when filters change deeply', async () => {
    const items = [{ id: '1', type: 'person', name: 'Alice', archived: false }]
    const sortCriteria = [{ type: 'name', reverse: false }]

    const { rerender } = renderHook(
      ({ filters }) => useAsyncItems({
        items: items as any,
        filters: filters as any,
        sortCriteria: sortCriteria as any,
        showArchived: false,
      }),
      {
        initialProps: {
          filters: [{ type: 'name', baseOperator: 'contains', inverse: false, operator: 'contains', value: 'Group' }],
        },
      },
    )

    await waitFor(() => {
      expect(mocks.processItemsWithWorker).toHaveBeenCalledTimes(1)
    })

    rerender({
      filters: [{ type: 'name', baseOperator: 'contains', inverse: false, operator: 'contains', value: 'Person' }],
    })

    await waitFor(() => {
      expect(mocks.processItemsWithWorker).toHaveBeenCalledTimes(2)
    })
  })
})
