import { render, screen, fireEvent } from '@testing-library/react'
import ConfirmationDialog from './ConfirmationDialog'
import { checkA11y } from '../../testUtils/axe'

describe('ConfirmationDialog accessibility & interactions', () => {
  it('renders title, content, and triggers confirm/cancel handlers', async () => {
    const handleConfirm = vi.fn()
    const handleCancel = vi.fn()

    const { container } = render(
      <ConfirmationDialog
        open={true}
        title="Delete Item"
        confirm="Delete"
        cancel="Cancel"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      >
        Are you sure you want to delete this item?
      </ConfirmationDialog>,
    )

    expect(screen.getByText('Delete Item')).toBeDefined()
    expect(screen.getByText('Are you sure you want to delete this item?')).toBeDefined()

    await checkA11y(container)

    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(handleConfirm).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(handleCancel).toHaveBeenCalledTimes(1)
  })
})
