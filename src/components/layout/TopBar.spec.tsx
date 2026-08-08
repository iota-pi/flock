import { act, fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { MemoryRouter } from 'react-router'
import getTheme from '../../theme'
import TopBar from './TopBar'
import { checkA11y } from '../../testUtils/axe'
import { useAppStore } from '../../state/store'

const theme = getTheme(false)

describe('TopBar component & accessibility', () => {
  beforeEach(() => {
    act(() => {
      useAppStore.setState({ showArchived: false })
    })
  })

  it('renders top bar with filter, sort, and select-all controls with zero a11y violations', async () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <TopBar
            allSelected={false}
            filterable={true}
            sortable={true}
            menuItems={[]}
            title="People"
          />
        </MemoryRouter>
      </ThemeProvider>,
    )

    await checkA11y(container)
  })

  it('toggles show/hide archived items via options menu', () => {
    render(
      <ThemeProvider theme={theme}>
        <MemoryRouter>
          <TopBar
            allSelected={false}
            filterable={true}
            sortable={true}
            menuItems={[]}
            title="People"
          />
        </MemoryRouter>
      </ThemeProvider>,
    )

    // Open options menu
    const optionsButton = screen.getByRole('button', { name: 'Open actions menu' })
    fireEvent.click(optionsButton)

    // Check "Show archived items" menu item exists and click it
    const toggleMenuItem = screen.getByText('Show archived items')
    expect(toggleMenuItem).toBeTruthy()
    fireEvent.click(toggleMenuItem)

    // Store state should be updated to true
    expect(useAppStore.getState().showArchived).toBe(true)
  })
})
