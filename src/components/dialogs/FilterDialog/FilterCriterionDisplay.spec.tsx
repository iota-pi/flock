import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'

import getTheme from 'src/theme'
import { FilterCriterionDisplay } from './FilterCriterionDisplay'
import type { FilterCriterion } from 'src/utils/customFilter'
import type { GroupItem, ItemId } from 'src/shared/schemas/items'


const mockGroups: GroupItem[] = [
  {
    id: 'g2' as ItemId,
    type: 'group',
    name: 'Youth Group',
    archived: false,
    created: 0,
    description: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
    members: [],
    memberPrayerFrequency: 'none',
    memberPrayerTarget: 'one',
  },
  {
    id: 'g1' as ItemId,
    type: 'group',
    name: 'Alpha Team',
    archived: false,
    created: 0,
    description: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
    members: [],
    memberPrayerFrequency: 'none',
    memberPrayerTarget: 'one',
  },
  {
    id: 'g3' as ItemId,
    type: 'group',
    name: 'Archived Group',
    archived: true,
    created: 0,
    description: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
    members: [],
    memberPrayerFrequency: 'none',
    memberPrayerTarget: 'one',
  },
]

function renderWithProviders(ui: React.ReactNode) {
  return render(
    <ThemeProvider theme={getTheme(false)}>
      <LocalizationProvider dateAdapter={AdapterDateFns}>
        {ui}
      </LocalizationProvider>
    </ThemeProvider>,
  )
}

describe('FilterCriterionDisplay', () => {
  const defaultCriterion: FilterCriterion = {
    type: 'groups',
    baseOperator: 'contains',
    inverse: false,
    operator: 'contains',
    value: '',
  }

  it('renders dropdown/search autocomplete for groups criterion', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onRemove = vi.fn()

    renderWithProviders(
      <FilterCriterionDisplay
        chosenCriteria={new Set()}
        criterion={defaultCriterion}
        groups={mockGroups}
        index={0}
        onChange={onChange}
        onRemove={onRemove}
      />,
    )

    const valueInputs = screen.getAllByLabelText('Value')
    const groupInput = valueInputs[0]
    expect(groupInput).toBeTruthy()

    // Open the dropdown by clicking or typing
    await user.click(groupInput)
    await user.type(groupInput, 'Youth')

    // Find option in dropdown
    const option = await screen.findByRole('option', { name: 'Youth Group' })
    expect(option).toBeTruthy()

    // Archived group should not be in the options
    expect(screen.queryByRole('option', { name: 'Archived Group' })).toBeNull()

    // Click to select
    await user.click(option)

    expect(onChange).toHaveBeenCalledWith(0, {
      ...defaultCriterion,
      value: 'Youth Group',
    })
  })

  it('displays the selected group name when criterion.value is set', () => {
    const onChange = vi.fn()
    const onRemove = vi.fn()

    const criterionWithGroup: FilterCriterion = {
      type: 'groups',
      baseOperator: 'contains',
      inverse: false,
      operator: 'contains',
      value: 'Alpha Team',
    }

    renderWithProviders(
      <FilterCriterionDisplay
        chosenCriteria={new Set()}
        criterion={criterionWithGroup}
        groups={mockGroups}
        index={0}
        onChange={onChange}
        onRemove={onRemove}
      />,
    )

    const input = screen.getByDisplayValue('Alpha Team')
    expect(input).toBeTruthy()
  })

  it('clears the group selection when clear button is clicked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onRemove = vi.fn()

    const criterionWithGroup: FilterCriterion = {
      type: 'groups',
      baseOperator: 'contains',
      inverse: false,
      operator: 'contains',
      value: 'Alpha Team',
    }

    renderWithProviders(
      <FilterCriterionDisplay
        chosenCriteria={new Set()}
        criterion={criterionWithGroup}
        groups={mockGroups}
        index={0}
        onChange={onChange}
        onRemove={onRemove}
      />,
    )

    const clearButton = screen.getByTitle('Clear')
    await user.click(clearButton)

    expect(onChange).toHaveBeenCalledWith(0, {
      ...criterionWithGroup,
      value: '',
    })
  })

  it('renders standard text field for string criterion', () => {
    const onChange = vi.fn()
    const onRemove = vi.fn()

    const stringCriterion: FilterCriterion = {
      type: 'name',
      baseOperator: 'contains',
      inverse: false,
      operator: 'contains',
      value: 'John',
    }

    renderWithProviders(
      <FilterCriterionDisplay
        chosenCriteria={new Set()}
        criterion={stringCriterion}
        groups={mockGroups}
        index={0}
        onChange={onChange}
        onRemove={onRemove}
      />,
    )

    const input = screen.getByDisplayValue('John')
    expect(input).toBeTruthy()

    fireEvent.change(input, { target: { value: 'Johnny' } })
    expect(onChange).toHaveBeenCalledWith(0, {
      ...stringCriterion,
      value: 'Johnny',
    })
  })
})
