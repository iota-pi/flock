import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import getTheme from '../../../theme'
import ItemFormContent from './ItemFormContent'
import type { DirtyItem, Item } from '../../../state/items'
import { getBlankPerson } from '../../../state/items'

vi.mock('../../../state/selectors', () => ({
  useItems: vi.fn(),
}))

vi.mock('../../../components/FrequencyControls', () => ({
  default: () => <div data-testid="frequency-controls" />,
}))

vi.mock('../../groups/components/GroupDisplay', () => ({
  default: () => <div data-testid="group-display" />,
}))

vi.mock('../../groups/components/MemberDisplay', () => ({
  default: () => <div data-testid="member-display" />,
}))

vi.mock('../../../components/NotesSection', () => ({
  default: () => <div data-testid="notes-section" />,
}))

vi.mock('../../../components/drawers/utils/CollapsibleSection', () => ({
  default: ({ content }: { content: React.ReactNode }) => <div>{content}</div>,
}))

const { useItems } = await import('../../../state/selectors')

function renderWithTheme(ui: React.ReactNode) {
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

  it('marks name as required and reports updates immediately while empty', async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    const item = {
      ...getBlankPerson('item-1', false),
      name: 'Initial Name',
    } as DirtyItem<Item>

    vi.mocked(useItems).mockReturnValue([])

    renderWithTheme(
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
    expect(handleChange).toHaveBeenCalledWith({ name: '' })
  })

  it('shows duplicate warning for same-name same-type items', () => {
    const handleChange = vi.fn()
    const item = {
      ...getBlankPerson('item-1', false),
      name: 'John Doe',
    } as DirtyItem<Item>

    vi.mocked(useItems).mockReturnValue([item, { ...getBlankPerson('item-2', false), name: 'John Doe' }])

    renderWithTheme(
      <ItemFormContent
        item={item}
        handleChange={handleChange}
      />,
    )

    expect(screen.getByText(/other person with this name/i)).toBeTruthy()
  })
})
