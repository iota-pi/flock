import { render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from '../../theme'
import BaseDrawer from './BaseDrawer'
import { checkA11y } from '../../testUtils/axe'

const theme = getTheme(false)

describe('BaseDrawer component & accessibility', () => {
  it('renders open drawer without accessibility violations', async () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <BaseDrawer open={true} onClose={() => {}}>
          <div>Drawer Content</div>
        </BaseDrawer>
      </ThemeProvider>,
    )

    await checkA11y(container)
  })
})
