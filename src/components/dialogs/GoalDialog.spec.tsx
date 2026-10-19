import { render, screen, fireEvent } from '@testing-library/react'
import GoalDialog from './GoalDialog'
import { checkA11y } from '../../testUtils/axe'

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
    await checkA11y(container)
  })

  it('sets enterkeyhint="done" on prayer goal input and blurs on Enter', () => {
    render(<GoalDialog open={true} onClose={() => {}} naturalGoal={5} />)

    const input = screen.getByRole('spinbutton', { name: /prayer goal/i }) as HTMLInputElement
    expect(input.getAttribute('enterkeyhint')).toBe('done')

    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.activeElement).not.toBe(input)
  })
})
