import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'

import getTheme from 'src/theme'
import ItemFormContent from './ItemFormContent'
import type { Item } from 'src/state/items'
import { getBlankPerson } from 'src/state/items'


vi.mock('src/components/FrequencyControls', () => ({
  default: () => <div data-testid="frequency-controls" />,
}))

vi.mock('../../groups/components/GroupDisplay', () => ({
  default: () => <div data-testid="group-display" />,
}))

vi.mock('../../groups/components/MemberDisplay', () => ({
  default: () => <div data-testid="member-display" />,
}))

vi.mock('src/components/NotesSection', () => ({
  default: () => <div data-testid="notes-section" />,
}))

vi.mock('src/components/drawers/utils/CollapsibleSection', () => ({
  default: ({ content }: { content: React.ReactNode }) => <div>{content}</div>,
}))

function renderWithContext(ui: React.ReactNode) {
  return render(
    <ThemeProvider theme={getTheme(false)}>
      {ui}
    </ThemeProvider>,
  )
}

describe('ItemFormContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks name as required and commits updates when the field blurs', async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    const item = {
      ...getBlankPerson('item-1', false),
      name: 'Initial Name',
    } as Item

    renderWithContext(
      <ItemFormContent
        item={item}
        handleChange={handleChange}
      />,
    )

    const nameInput = document.querySelector('input[data-cy="name"]') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (!nameInput) {
      return
    }
    expect(nameInput.required).toBe(true)

    await user.clear(nameInput)
    fireEvent.blur(nameInput)
    expect(handleChange).toHaveBeenCalledWith({ name: '' })
  })

  it('shows duplicate warning for same-name same-type items', () => {
    const handleChange = vi.fn()
    const item = {
      ...getBlankPerson('item-1', false),
      name: 'John Doe',
    } as Item

    renderWithContext(
      <ItemFormContent
        item={item}
        handleChange={handleChange}
      />,
    )

    expect(screen.getByText(/other person with this name/i)).toBeTruthy()
  })
})
