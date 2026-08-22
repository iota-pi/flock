import { act, render, screen, fireEvent } from '@testing-library/react'
import DataRecoveryDialog from './DataRecoveryDialog'
import { useAppStore } from '../../state/store'
import type { ErrorItem, ItemId } from 'src/shared/schemas/items'
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
})
