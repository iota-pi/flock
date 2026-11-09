import { act, fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from '../../theme'
import AccountCreatedDialog from './AccountCreatedDialog'
import { checkA11y } from '../../testUtils/axe'

const theme = getTheme(false)

function renderDialog(onContinue = vi.fn()) {
  return render(
    <ThemeProvider theme={theme}>
      <AccountCreatedDialog accountId="abcd1234" password="secret" open={true} onContinue={onContinue} />
    </ThemeProvider>,
  )
}

describe('AccountCreatedDialog', () => {
  it('shows the account ID with its hyphen and passes accessibility audits', async () => {
    renderDialog()

    const idField = screen.getByDisplayValue('abcd-1234')
    expect(idField.getAttribute('autocomplete')).toBe('username')
    await checkA11y(document.body)
  })

  it('gives password managers the ID and password together in one form', () => {
    renderDialog()

    const form = screen.getByDisplayValue('abcd-1234').closest('form')
    const passwordInput = form?.querySelector<HTMLInputElement>('input[type="password"]')
    expect(passwordInput?.value).toBe('secret')
    expect(passwordInput?.getAttribute('autocomplete')).toBe('new-password')
  })

  it('continues on submit only once the user says they saved the ID', async () => {
    const onContinue = vi.fn()
    renderDialog(onContinue)
    const continueButton = screen.getByRole('button', { name: /Continue/i })
    expect(continueButton).toHaveProperty('disabled', true)

    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox'))
    })
    await act(async () => {
      fireEvent.click(continueButton)
    })

    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})
