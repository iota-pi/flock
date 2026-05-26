import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material'
import { describe, expect, it, vi } from 'vitest'
import getTheme from '../theme'
import FrequencyPicker from './FrequencyPicker'

const lightTheme = getTheme(false)

const renderWithTheme = (ui: React.ReactNode) => {
  return render(
    <ThemeProvider theme={lightTheme}>
      {ui}
    </ThemeProvider>
  )
}

describe('FrequencyPicker', () => {
  it('selecting custom triggers a default weekly value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    renderWithTheme(
      <FrequencyPicker
        frequency="weekly"
        id="frequency"
        label="Frequency"
        onChange={onChange}
      />
    )

    const select = screen.getByRole('combobox')
    await user.click(select)
    await user.click(screen.getByText('Custom...'))

    expect(onChange).toHaveBeenLastCalledWith(7)
  })

  it('shows custom fields for numeric frequencies', () => {
    const onChange = vi.fn()

    renderWithTheme(
      <FrequencyPicker
        frequency={14}
        id="frequency"
        label="Frequency"
        onChange={onChange}
      />
    )

    const amountInput = screen.getByRole('spinbutton') as HTMLInputElement
    expect(amountInput.value).toBe('2')
    expect(screen.getByText('Weeks')).toBeTruthy()
  })

  it('converts custom amount changes to days', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    renderWithTheme(
      <FrequencyPicker
        frequency={14}
        id="frequency"
        label="Frequency"
        onChange={onChange}
      />
    )

    const amountInput = screen.getByRole('spinbutton') as HTMLInputElement
    await user.clear(amountInput)
    await user.type(amountInput, '3')

    const lastCall = onChange.mock.calls.at(-1)?.[0]
    expect(lastCall).toBe(21)
  })

  it('converts custom unit changes to days', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    renderWithTheme(
      <FrequencyPicker
        frequency={14}
        id="frequency"
        label="Frequency"
        onChange={onChange}
      />
    )

    const unitSelect = screen.getByText('Weeks')
    await user.click(unitSelect)
    await user.click(screen.getByText('Months'))

    const lastCall = onChange.mock.calls.at(-1)?.[0]
    const expectedDays = 2 * (365.25 / 12)
    expect(lastCall).toBeCloseTo(expectedDays)
  })
})
