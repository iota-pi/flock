import { render, screen, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'
import GoalDialog from './GoalDialog'

describe('GoalDialog component & accessibility', () => {
  it('renders prayer goal input and handles value changes', () => {
    const handleClose = vi.fn()
    render(<GoalDialog open={true} onClose={handleClose} naturalGoal={5} />)

    const input = screen.getByRole('spinbutton', { name: /prayer goal/i })
    expect(input).toBeDefined()

    fireEvent.change(input, { target: { value: '10' } })
    expect((input as HTMLInputElement).value).toBe('10')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<GoalDialog open={true} onClose={() => {}} naturalGoal={5} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
