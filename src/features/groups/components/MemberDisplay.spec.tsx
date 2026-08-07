import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from 'src/theme'
import MemberDisplay from './MemberDisplay'
import type { GroupItem, ItemId } from 'src/shared/schemas/items'

vi.mock('src/components/Search', () => ({
  default: ({ label, noItemsText }: { label: string, noItemsText: string }) => (
    <div data-testid="search">
      <span>{label}</span>
      <span>{noItemsText}</span>
    </div>
  ),
}))

vi.mock('../../items/components/ItemList', () => ({
  default: () => <div data-testid="item-list" />,
}))

const mockGroup: GroupItem = {
  id: 'g1' as ItemId,
  name: 'Test Group',
  type: 'group',
  archived: false,
  created: 1000,
  description: '',
  notes: [],
  prayedFor: [],
  prayerFrequency: 'none',
  members: ['p1' as ItemId, 't1' as ItemId],
  memberPrayerFrequency: 'weekly',
  memberPrayerTarget: 'all',
}

describe('MemberDisplay', () => {
  it('renders search input configured for adding group members', () => {
    render(
      <ThemeProvider theme={getTheme(false)}>
        <MemberDisplay
          group={mockGroup}
          memberIds={mockGroup.members}
          onChange={vi.fn()}
        />
      </ThemeProvider>,
    )

    expect(screen.getByText('Add group members')).toBeTruthy()
    expect(screen.getByText('No people or topics found')).toBeTruthy()
    expect(screen.getByTestId('item-list')).toBeTruthy()
  })
})
