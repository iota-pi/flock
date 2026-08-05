import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Search from './Search'
import { ThemeProvider } from '@mui/material/styles'

import getTheme from '../theme'


// Mocks
vi.mock('../state/selectors', async importOriginal => {
  const actual = await importOriginal<typeof import('../state/selectors')>()
  return {
    ...actual,
    useItemsByIds: vi.fn(),
    useMetadata: vi.fn(),
    useSearchItems: vi.fn(),
  }
})
vi.mock('../state/store', () => ({
  useAppStore: vi.fn(),
}))
vi.mock('../utils/customSort', () => ({
  sortItems: vi.fn(items => items),
}))

import { useItemsByIds, useMetadata, useSearchItems } from '../state/selectors'
import { useAppStore } from '../state/store'
import { Item } from '../state/items'
import { ItemId } from 'src/shared/schemas/items'

const lightTheme = getTheme(false)

const renderWithTheme = (ui: React.ReactNode) => {
  return render(
    <ThemeProvider theme={lightTheme}>
      {ui}
    </ThemeProvider>
  )
}

describe('Search Component', () => {
  const mockOnSelect = vi.fn()
  const mockOnCreate = vi.fn()

  const items: Item[] = [
    { id: '1' as ItemId, name: 'Alice', type: 'person', description: 'Friend', created: 0, archived: false, prayedFor: [], prayerFrequency: 'monthly', notes: [] },
    { id: '2' as ItemId, name: 'Bob', type: 'person', description: 'Coworker', created: 0, archived: false, prayedFor: [], prayerFrequency: 'monthly', notes: [] },
    { id: '3' as ItemId, name: 'Group A', type: 'group', description: '', created: 0, archived: false, prayedFor: [], prayerFrequency: 'none', notes: [], members: [], memberPrayerFrequency: 'monthly', memberPrayerTarget: 'one' },
    { id: '4' as ItemId, name: 'Old', type: 'person', description: 'Archived', created: 0, archived: true, prayedFor: [], prayerFrequency: 'none', notes: [] },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useSearchItems).mockImplementation(options => (
      items.filter(item => (
        options.types[item.type]
        && (options.includeArchived || !item.archived)
      ))
    ))
    vi.mocked(useItemsByIds).mockReturnValue([])
    vi.mocked(useMetadata).mockReturnValue([{}, vi.fn()])
    vi.mocked(useAppStore).mockImplementation(selector => selector({ darkMode: false } as any))
  })

  it('renders input field', () => {
    renderWithTheme(<Search />)
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  it('displays items in the list when clicked (focused)', async () => {
    const user = userEvent.setup()
    renderWithTheme(<Search />)

    const input = screen.getByRole('combobox')
    await user.click(input)
    await user.keyboard('{ArrowDown}')
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Alice')).toBeTruthy()
    expect(within(listbox).getByText('Bob')).toBeTruthy()
    expect(within(listbox).getByText('Group A')).toBeTruthy()
    expect(within(listbox).queryByText('Old')).toBeNull()
  })

  it('filters items by input text', async () => {
    const user = userEvent.setup()
    renderWithTheme(<Search />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'Ali')

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Alice')).toBeTruthy()
    expect(within(listbox).queryByText('Bob')).toBeNull()
  })

  it('filters items by searching notes', async () => {
    const user = userEvent.setup()

    const itemWithNote = {
      ...items[0],
      id: '5' as ItemId,
      name: 'HasNote',
      notes: [{ id: 'n1', text: 'SecretDetail', archived: false, time: 0 }]
    }
    vi.mocked(useSearchItems).mockReturnValue([...items, itemWithNote])

    renderWithTheme(<Search searchSummary />) // searchSummary enables note search

    const input = screen.getByRole('combobox')
    await user.type(input, 'Secret')

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('HasNote')).toBeTruthy()
  })

  it('shows archived items when includeArchived is true', async () => {
    const user = userEvent.setup()
    renderWithTheme(<Search includeArchived />)

    const input = screen.getByRole('combobox')
    await user.click(input)

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Old')).toBeTruthy()
  })

  it('filters by types prop', async () => {
    const user = userEvent.setup()
    renderWithTheme(<Search types={{ group: true }} />)

    const input = screen.getByRole('combobox')
    await user.click(input)

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Group A')).toBeTruthy()
    expect(within(listbox).queryByText('Alice')).toBeNull()
  })

  it('calls onSelect when item is clicked', async () => {
    const user = userEvent.setup()
    renderWithTheme(<Search onSelect={mockOnSelect} />)

    const input = screen.getByRole('combobox')
    await user.click(input)

    const listbox = await screen.findByRole('listbox')
    await user.click(within(listbox).getByText('Alice'))

    expect(mockOnSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '1', name: 'Alice' }))
  })

  it('shows create options when input does not match exactly and onCreate is provided', async () => {
    const user = userEvent.setup()
    renderWithTheme(<Search onCreate={mockOnCreate} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'NewUser')

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByText(/NewUser/)[0]).toBeTruthy()

    const options = within(listbox).getAllByRole('option')


    await user.click(options[0])
    expect(mockOnCreate).toHaveBeenCalled()
    const createdItem = mockOnCreate.mock.calls[0][0]
    expect(createdItem.name).toBe('NewUser')
  })

  it('renders selected chips with max chip overflow', () => {
    const selected = [items[0], items[1], items[2]]
    vi.mocked(useItemsByIds).mockReturnValue(selected)
    renderWithTheme(
      <Search
        selectedItemIds={selected.map(item => item.id)}
        showSelectedChips
        maxChips={2}
      />
    )

    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.queryByText('Group A')).toBeNull()
  })
})
