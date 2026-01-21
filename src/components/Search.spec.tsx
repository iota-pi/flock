import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Search from './Search'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { ThemeProvider } from '@mui/material'
import getTheme from '../theme'

// Mocks
vi.mock('../state/selectors', () => ({
  useItems: vi.fn(),
  useMetadata: vi.fn(),
  useSortCriteria: vi.fn(),
}))
vi.mock('../store', () => ({
  useAppSelector: vi.fn(),
}))
vi.mock('../utils/customSort', () => ({
  sortItems: vi.fn(items => items),
}))

const lightTheme = getTheme(false)

const renderWithTheme = (ui: React.ReactNode) => {
  return render(
    <ThemeProvider theme={lightTheme}>
      {ui}
    </ThemeProvider>
  )
}

import { useItems, useMetadata, useSortCriteria } from '../state/selectors'
import { useAppSelector } from '../store'
import { Item } from '../state/items'

describe('Search Component', () => {
  const mockOnSelect = vi.fn()
  const mockOnCreate = vi.fn()

  const items: Item[] = [
    { id: '1', version: 0, name: 'Alice', type: 'person', description: 'Friend', created: 0, archived: false, prayedFor: [], prayerFrequency: 'monthly', summary: '' },
    { id: '2', version: 0, name: 'Bob', type: 'person', description: 'Coworker', created: 0, archived: false, prayedFor: [], prayerFrequency: 'monthly', summary: '' },
    { id: '3', version: 0, name: 'Group A', type: 'group', description: '', created: 0, archived: false, prayedFor: [], prayerFrequency: 'none', summary: '', members: [], memberPrayerFrequency: 'monthly', memberPrayerTarget: 'one' },
    { id: '4', version: 0, name: 'Old', type: 'person', description: 'Archived', created: 0, archived: true, prayedFor: [], prayerFrequency: 'none', summary: '' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useItems).mockReturnValue(items)
    vi.mocked(useMetadata).mockReturnValue([{}, vi.fn()])
    vi.mocked(useSortCriteria).mockReturnValue([[], vi.fn()])
    vi.mocked(useAppSelector).mockReturnValue(false)
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
})
