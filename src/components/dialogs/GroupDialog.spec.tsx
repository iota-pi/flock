import { render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from '../../theme'
import GroupDialog from './GroupDialog'
import { checkA11y } from '../../testUtils/axe'

const theme = getTheme(false)

describe('GroupDialog accessibility', () => {
  it('renders group selection search and passes accessibility audits', async () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <GroupDialog items={[]} open={true} onClose={() => {}} />
      </ThemeProvider>,
    )

    await checkA11y(container)
  })
})
