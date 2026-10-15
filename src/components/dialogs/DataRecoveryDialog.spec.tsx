import { act, render, screen, fireEvent } from '@testing-library/react'
import DataRecoveryDialog from './DataRecoveryDialog'
import { useAppStore } from '../../state/store'
import type { ErrorItem } from 'src/shared/schemas/items'
import type { ItemId } from '@vault/shared'
import { MAX_ITEM_SIZE_KB } from '@vault/shared'
import * as itemMutations from '../../features/items/mutations/itemMutations'
import * as dataRecoveryHook from '../../hooks/useDataRecovery'

describe('DataRecoveryDialog', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useAppStore.setState({
        items: {},
        itemIds: [],
      })
    })
  })

  it('renders empty message when no recovery or quarantined items exist', () => {
    vi.spyOn(dataRecoveryHook, 'useDataRecovery').mockReturnValue({
      recoveryItems: [],
      isRetrying: null,
      handleDismissRecoveryItem: vi.fn(),
      handleRetryCorruptedItem: vi.fn(),
      handleForceOverwriteCorruptedItem: vi.fn(),
      handleForceDeleteCorruptedItem: vi.fn(),
      handleRecreateItem: vi.fn(),
      handleCompactItem: vi.fn(),
    })

    render(<DataRecoveryDialog open={true} onClose={onClose} />)

    expect(screen.getByText('No corrupted or quarantined data recovery actions are required right now.')).toBeDefined()
  })

  it('renders quarantined items and deletes globally on confirmation', async () => {
    const errorItem: ErrorItem = {
      id: 'error-item-1' as ItemId,
      name: 'Corrupt Item 1',
      description: 'Could not parse',
      type: 'error',
      created: 1000,
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    act(() => {
      useAppStore.setState({
        items: {
          'error-item-1': errorItem,
        },
        itemIds: ['error-item-1' as ItemId],
      })
    })

    vi.spyOn(dataRecoveryHook, 'useDataRecovery').mockReturnValue({
      recoveryItems: [],
      isRetrying: null,
      handleDismissRecoveryItem: vi.fn(),
      handleRetryCorruptedItem: vi.fn(),
      handleForceOverwriteCorruptedItem: vi.fn(),
      handleForceDeleteCorruptedItem: vi.fn(),
      handleRecreateItem: vi.fn(),
      handleCompactItem: vi.fn(),
    })

    const deleteItemsSpy = vi.spyOn(itemMutations, 'deleteItems').mockResolvedValue(['error-item-1' as ItemId])

    render(<DataRecoveryDialog open={true} onClose={onClose} />)

    expect(screen.getByText('Quarantined item (Unrecognized format)')).toBeDefined()
    expect(screen.getByText(/Item ID: error-item-1/)).toBeDefined()

    // Click Delete Globally
    const deleteButton = screen.getByRole('button', { name: /delete globally/i })
    fireEvent.click(deleteButton)

    // Confirmation dialog should appear
    expect(screen.getByText('Delete Quarantined Item Globally?')).toBeDefined()
    expect(screen.getByText(/Warning: This item failed schema validation locally/)).toBeDefined()

    // Confirm the deletion
    const confirmButton = screen.getByRole('button', { name: /^delete globally$/i })
    await act(async () => {
      fireEvent.click(confirmButton)
    })

    expect(deleteItemsSpy).toHaveBeenCalledWith('error-item-1')
  })

  it('renders oversized item with Recreate Item button and calls handleRecreateItem', async () => {
    const handleRecreateItem = vi.fn()
    vi.spyOn(dataRecoveryHook, 'useDataRecovery').mockReturnValue({
      recoveryItems: [
        {
          id: 'rec-1',
          itemId: 'item-oversized' as ItemId,
          reason: `Snapshot size (360 KB) exceeds ${MAX_ITEM_SIZE_KB} KB limit. Recreating the item with fresh history is required to resume sync.`,
          kind: 'oversized',
          createdAt: Date.now(),
        },
      ],
      isRetrying: null,
      handleDismissRecoveryItem: vi.fn(),
      handleRetryCorruptedItem: vi.fn(),
      handleForceOverwriteCorruptedItem: vi.fn(),
      handleForceDeleteCorruptedItem: vi.fn(),
      handleRecreateItem,
      handleCompactItem: handleRecreateItem,
    })

    render(<DataRecoveryDialog open={true} onClose={onClose} />)

    expect(screen.getByText('Item edit history too large to sync')).toBeDefined()
    expect(screen.getByText(new RegExp(`exceeds ${MAX_ITEM_SIZE_KB} KB limit`))).toBeDefined()

    const compactButton = screen.getByRole('button', { name: /recreate item/i })
    fireEvent.click(compactButton)

    expect(handleRecreateItem).toHaveBeenCalledWith('item-oversized')
  })

  it('does not offer Recreate Item for non-oversized entries whose reason mentions a limit', () => {
    vi.spyOn(dataRecoveryHook, 'useDataRecovery').mockReturnValue({
      recoveryItems: [
        {
          id: 'rec-2',
          itemId: 'item-push' as ItemId,
          reason: 'Push failed after 5 consecutive attempts: Rate limit exceeded',
          kind: 'pushFailure',
          createdAt: Date.now(),
        },
      ],
      isRetrying: null,
      handleDismissRecoveryItem: vi.fn(),
      handleRetryCorruptedItem: vi.fn(),
      handleForceOverwriteCorruptedItem: vi.fn(),
      handleForceDeleteCorruptedItem: vi.fn(),
      handleRecreateItem: vi.fn(),
      handleCompactItem: vi.fn(),
    })

    render(<DataRecoveryDialog open={true} onClose={onClose} />)

    expect(screen.queryByRole('button', { name: /recreate item/i })).toBeNull()
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /overwrite/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /delete/i })).toBeDefined()
  })
})
