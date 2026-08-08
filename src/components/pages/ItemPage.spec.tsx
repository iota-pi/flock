import { act, render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { createMemoryRouter, RouterProvider } from 'react-router'

import getTheme from '../../theme'
import ItemPage from './ItemPage'
import { useAppStore } from '../../state/store'
import type { GroupItem, ItemId, PersonItem } from '../../shared/schemas/items'
import { DEFAULT_FILTER_CRITERIA } from '../../utils/customFilter'

const lightTheme = getTheme(false)

const renderWithProviders = (ui: React.ReactNode) => {
  const router = createMemoryRouter([
    {
      path: '/',
      element: ui,
      handle: { isPage: true },
    },
  ])
  return render(
    <ThemeProvider theme={lightTheme}>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}

describe('ItemPage - Selection refinement by visible items', () => {
  const person1: PersonItem = {
    id: 'person-1' as ItemId,
    name: 'Alice',
    type: 'person',
    description: '',
    created: 1000,
    archived: false,
    prayedFor: [],
    prayerFrequency: 'monthly',
    notes: [],
  }

  const person2: PersonItem = {
    id: 'person-2' as ItemId,
    name: 'Bob',
    type: 'person',
    description: '',
    created: 2000,
    archived: false,
    prayedFor: [],
    prayerFrequency: 'monthly',
    notes: [],
  }

  beforeEach(() => {
    act(() => {
      useAppStore.setState({
        items: {
          'person-1': person1,
          'person-2': person2,
        },
        itemIds: ['person-1' as ItemId, 'person-2' as ItemId],
        selected: ['person-1' as ItemId, 'person-2' as ItemId],
        filters: DEFAULT_FILTER_CRITERIA,
        showArchived: false,
      })
    })
  })

  it('deselects an item when it is archived and hidden by showArchived=false', () => {
    renderWithProviders(<ItemPage itemType="person" />)
    expect(useAppStore.getState().selected).toEqual(['person-1', 'person-2'])

    // Archive person-1
    act(() => {
      useAppStore.setState({
        items: {
          'person-1': { ...person1, archived: true },
          'person-2': person2,
        },
      })
    })

    expect(useAppStore.getState().selected).toEqual(['person-2'])
  })

  it('keeps an item selected when it is archived but visible when showArchived=true', () => {
    act(() => {
      useAppStore.setState({
        showArchived: true,
        selected: ['person-1' as ItemId],
        items: {
          'person-1': { ...person1, archived: true },
        },
        itemIds: ['person-1' as ItemId],
      })
    })

    renderWithProviders(<ItemPage itemType="person" />)

    expect(useAppStore.getState().selected).toEqual(['person-1'])
  })

  it('deselects an item when its type changes', () => {
    renderWithProviders(<ItemPage itemType="person" />)
    expect(useAppStore.getState().selected).toEqual(['person-1', 'person-2'])

    // Convert person-1 to group
    const group1: GroupItem = {
      ...person1,
      type: 'group',
      members: [],
      memberPrayerFrequency: 'none',
      memberPrayerTarget: 'one',
    }

    act(() => {
      useAppStore.setState({
        items: {
          'person-1': group1,
          'person-2': person2,
        },
      })
    })

    expect(useAppStore.getState().selected).toEqual(['person-2'])
  })

  it('deselects an item when it is filtered out by search/filter criteria', () => {
    renderWithProviders(<ItemPage itemType="person" />)
    expect(useAppStore.getState().selected).toEqual(['person-1', 'person-2'])

    // Apply name filter for 'Bob'
    act(() => {
      useAppStore.setState({
        filters: [
          ...DEFAULT_FILTER_CRITERIA,
          {
            type: 'name',
            baseOperator: 'contains',
            operator: 'contains',
            inverse: false,
            value: 'Bob',
          },
        ],
      })
    })

    expect(useAppStore.getState().selected).toEqual(['person-2'])
  })
})

describe('ItemPage - Group member counts excluding archived members', () => {
  const activePerson: PersonItem = {
    id: 'person-active' as ItemId,
    name: 'Alice',
    type: 'person',
    description: '',
    created: 1000,
    archived: false,
    prayedFor: [],
    prayerFrequency: 'monthly',
    notes: [],
  }

  const archivedPerson: PersonItem = {
    id: 'person-archived' as ItemId,
    name: 'Bob',
    type: 'person',
    description: '',
    created: 2000,
    archived: true,
    prayedFor: [],
    prayerFrequency: 'monthly',
    notes: [],
  }

  const group: GroupItem = {
    id: 'group-1' as ItemId,
    name: 'Test Group',
    type: 'group',
    description: '',
    created: 3000,
    archived: false,
    prayedFor: [],
    prayerFrequency: 'monthly',
    notes: [],
    members: ['person-active' as ItemId, 'person-archived' as ItemId],
    memberPrayerFrequency: 'none',
    memberPrayerTarget: 'one',
  }

  it('excludes archived members from group member count string', () => {
    act(() => {
      useAppStore.setState({
        items: {
          'person-active': activePerson,
          'person-archived': archivedPerson,
          'group-1': group,
        },
        itemIds: ['group-1' as ItemId],
        selected: [],
        filters: DEFAULT_FILTER_CRITERIA,
        showArchived: false,
      })
    })

    const { getByText } = renderWithProviders(<ItemPage itemType="group" />)
    expect(getByText('1 member')).toBeTruthy()
  })
})

