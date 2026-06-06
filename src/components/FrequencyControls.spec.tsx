import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FrequencyControls from './FrequencyControls'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from '../theme'
import { useItemsByIds } from '../state/selectors'
import { GroupItem, ItemId } from '../shared/schemas/items'

vi.mock('../state/selectors', () => ({
  useItemsByIds: vi.fn(),
}))

const lightTheme = getTheme(false)

const renderWithTheme = (ui: React.ReactNode) => {
  return render(
    <ThemeProvider theme={lightTheme}>
      {ui}
    </ThemeProvider>
  )
}

describe('FrequencyControls', () => {
  const mockOnChange = vi.fn()
  const personId = 'p1' as ItemId

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useItemsByIds).mockReturnValue([])
  })

  it('renders frequency picker for person', () => {
    renderWithTheme(
      <FrequencyControls
        id={personId}
        partOfGroups={[]}
        prayerFrequency="weekly"
        onChange={mockOnChange}
      />
    )

    // Check label
    expect(screen.getByText('Prayer Frequency')).toBeTruthy()
  })

  it('displays last prayed information', () => {
    const lastPrayer = new Date('2024-01-01T12:00:00').getTime()
    renderWithTheme(
      <FrequencyControls
        id={personId}
        prayerFrequency="weekly"
        lastPrayer={lastPrayer}
        partOfGroups={[]}
        onChange={mockOnChange}
      />
    )

    expect(screen.getByText('Last prayed for:')).toBeTruthy()
  })

  it('shows inherited frequency message when group frequency is higher', () => {
    const group: GroupItem = {
      id: 'g1' as ItemId,
      name: 'My Group',
      type: 'group',
      description: '',
      created: 0,
      archived: false,
      prayedFor: [],
      prayerFrequency: 'none',
      notes: [],
      members: [personId],
      memberPrayerFrequency: 'daily',
      memberPrayerTarget: 'one'
    }

    vi.mocked(useItemsByIds).mockReturnValue([group])

    renderWithTheme(
      <FrequencyControls
        id={personId}
        prayerFrequency="monthly"
        onChange={mockOnChange}
        partOfGroups={[group.id]}
      />
    )

    expect(screen.getByText(/As a member of/)).toBeTruthy()
    expect(screen.getByText('My Group')).toBeTruthy()
  })

  it('does not show inherited frequency message when not faster', () => {
    const group: GroupItem = {
      id: 'g1' as ItemId,
      name: 'Slow Group',
      type: 'group',
      description: '',
      created: 0,
      archived: false,
      prayedFor: [],
      prayerFrequency: 'none',
      notes: [],
      members: [personId],
      memberPrayerFrequency: 'monthly',
      memberPrayerTarget: 'one',
    }

    vi.mocked(useItemsByIds).mockReturnValue([group])

    renderWithTheme(
      <FrequencyControls
        id={personId}
        prayerFrequency="weekly"
        onChange={mockOnChange}
        partOfGroups={[group.id]}
      />
    )

    expect(screen.queryByText(/As a member of/)).toBeNull()
  })

  it('renders additional controls for groups', () => {
    const groupId = 'g1' as ItemId
    const groupProps = {
      memberPrayerFrequency: 'weekly',
      memberPrayerTarget: 'one',
      prayerFrequency: 'monthly',
    } as const

    renderWithTheme(
      <FrequencyControls
        id={groupId}
        {...groupProps}
        onChange={mockOnChange}
      />
    )

    expect(screen.getByText('Pray For')).toBeTruthy()
    expect(screen.getByText('How often')).toBeTruthy()
    expect(screen.getByText(/choose how often to pray for the group/)).toBeTruthy()
  })

  it('updates member prayer target for groups', async () => {
    const user = userEvent.setup()
    const groupId = 'g2' as ItemId
    const groupProps = {
      memberPrayerFrequency: 'weekly',
      memberPrayerTarget: 'one',
      prayerFrequency: 'monthly',
    } as const

    renderWithTheme(
      <FrequencyControls
        id={groupId}
        {...groupProps}
        onChange={mockOnChange}
      />
    )

    const targetSelect = screen.getByLabelText('Pray For')
    await user.click(targetSelect)
    await user.click(screen.getByText('Every group member'))

    expect(mockOnChange).toHaveBeenCalledWith({ memberPrayerTarget: 'all' })
  })
})
