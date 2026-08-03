import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from '../../theme'
import AccountCreatedDialog from './AccountCreatedDialog'
import { checkA11y } from '../../testUtils/axe'

const theme = getTheme(false)

describe('AccountCreatedDialog accessibility', () => {
  it('renders account ID and passes accessibility audits', async () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <AccountCreatedDialog accountId="test-account-123" open={true} onContinue={() => {}} />
      </ThemeProvider>,
    )

    expect(screen.getByDisplayValue('test-account-123')).toBeDefined()
    await checkA11y(container)
  })
})
