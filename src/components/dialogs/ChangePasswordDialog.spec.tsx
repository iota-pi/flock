import { render, screen, fireEvent } from '@testing-library/react'
import ChangePasswordDialog from './ChangePasswordDialog'
import { checkA11y } from '../../testUtils/axe'

describe('ChangePasswordDialog accessibility & behavior', () => {
  it('renders password fields and passes accessibility audits', async () => {
    const { container } = render(<ChangePasswordDialog open={true} onClose={() => {}} />)

    expect(screen.getByLabelText(/current password/i)).toBeDefined()
    expect(screen.getByLabelText(/^new password/i)).toBeDefined()
    expect(screen.getByLabelText(/confirm new password/i)).toBeDefined()

    await checkA11y(container)
  })

  it('handles input entry', () => {
    render(<ChangePasswordDialog open={true} onClose={() => {}} />)

    const currentInput = screen.getByLabelText(/current password/i)
    fireEvent.change(currentInput, { target: { value: 'OldPass123!' } })
    expect((currentInput as HTMLInputElement).value).toBe('OldPass123!')
  })
})
