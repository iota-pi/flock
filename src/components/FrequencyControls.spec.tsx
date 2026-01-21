import { render, screen } from '@testing-library/react'
import FrequencyControls from './FrequencyControls'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { ThemeProvider } from '@mui/material'
import getTheme from '../theme'
import { useItems } from '../state/selectors'
import { GroupItem } from '../state/items'

// Mocks
vi.mock('../state/selectors', () => ({
  useItems: vi.fn(),
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
  const personId = 'p1'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useItems).mockReturnValue([])
  })

  it('renders frequency picker for person', () => {
    renderWithTheme(
      <FrequencyControls
        id={personId}
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
        onChange={mockOnChange}
      />
    )

    expect(screen.getByText('Last prayed for:')).toBeTruthy()
  })

  it('shows inherited frequency message when group frequency is higher', () => {
    const group: GroupItem = {
      id: 'g1',
      version: 0,
      name: 'My Group',
      type: 'group',
      description: '',
      created: 0,
      archived: false,
      prayedFor: [],
      prayerFrequency: 'none',
      summary: '',
      members: [personId],
      memberPrayerFrequency: 'daily',
      memberPrayerTarget: 'one'
    }

    vi.mocked(useItems).mockReturnValue([group])

    renderWithTheme(
      <FrequencyControls
        id={personId}
        prayerFrequency="monthly"
        onChange={mockOnChange}
      />
    )

    expect(screen.getByText(/As a member of/)).toBeTruthy()
    expect(screen.getByText('My Group')).toBeTruthy()
  })

  it('renders additional controls for groups', () => {
    const groupId = 'g1'
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
})
