import { render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { MemoryRouter } from 'react-router'
import getTheme from '../../theme'
import TopBar from './TopBar'
import { checkA11y } from '../../testUtils/axe'

const theme = getTheme(false)

describe('TopBar component & accessibility', () => {
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
})
