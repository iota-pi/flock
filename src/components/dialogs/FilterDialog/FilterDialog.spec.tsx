import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material/styles'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'

import getTheme from 'src/theme'
import FilterDialog from './FilterDialog'
import type { FilterCriterion } from 'src/utils/customFilter'


const setUi = vi.fn()
const initialFilters: FilterCriterion[] = [
  {
    type: 'name',
    baseOperator: 'contains',
    inverse: false,
    operator: 'contains',
    value: 'Tag X',
  },
]

vi.mock('src/state/store', () => ({
  useAppStore: (selector: (state: { setUi: typeof setUi, filters: FilterCriterion[] }) => unknown) => selector({
    setUi,
    filters: initialFilters,
  }),
}))

vi.mock('./FilterCriterionDisplay', () => ({
  FilterCriterionDisplay: ({ index, onChange, availableCriteria }: { index: number, onChange: (index: number, criterion: FilterCriterion) => void, availableCriteria?: string[] }) => (
    <div>
      <span data-testid={`available-count-${index}`}>{availableCriteria?.length ?? 0}</span>
      <span data-testid={`has-groups-${index}`}>{availableCriteria?.includes('groups') ? 'yes' : 'no'}</span>
      <button
        data-cy={`set-criterion-${index}`}
        onClick={() => onChange(index, {
          type: 'prayerFrequency',
          baseOperator: 'is',
          inverse: false,
          operator: 'is',
          value: 'daily',
        })}
        type="button"
      >
        set criterion {index}
      </button>
    </div>
  ),
}))

function renderWithProviders(ui: React.ReactNode) {
  return render(
    <ThemeProvider theme={getTheme(false)}>
      <LocalizationProvider dateAdapter={AdapterDateFns}>
        {ui}
      </LocalizationProvider>
    </ThemeProvider>,
  )
}

describe('FilterDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serializes multiple filter criteria into store payload on Done', async () => {
    userEvent.setup()
    const onClose = vi.fn()

    const { rerender } = renderWithProviders(<FilterDialog open={false} onClose={onClose} />)
    rerender(
      <ThemeProvider theme={getTheme(false)}>
        <LocalizationProvider dateAdapter={AdapterDateFns}>
          <FilterDialog open onClose={onClose} />
        </LocalizationProvider>
      </ThemeProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /set criterion 0/i }))
    fireEvent.click(screen.getByRole('button', { name: /done/i }))

    expect(setUi).toHaveBeenCalledWith({
      filters: [
        {
          type: 'prayerFrequency',
          baseOperator: 'is',
          inverse: false,
          operator: 'is',
          value: 'daily',
        },
      ],
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('omits groups criterion when itemType is group', () => {
    const onClose = vi.fn()
    const { rerender } = renderWithProviders(<FilterDialog itemType="group" open={false} onClose={onClose} />)
    rerender(
      <ThemeProvider theme={getTheme(false)}>
        <LocalizationProvider dateAdapter={AdapterDateFns}>
          <FilterDialog itemType="group" open onClose={onClose} />
        </LocalizationProvider>
      </ThemeProvider>,
    )

    expect(screen.getByTestId('has-groups-0').textContent).toBe('no')
  })

  it('includes groups criterion when itemType is person', () => {
    const onClose = vi.fn()
    const { rerender } = renderWithProviders(<FilterDialog itemType="person" open={false} onClose={onClose} />)
    rerender(
      <ThemeProvider theme={getTheme(false)}>
        <LocalizationProvider dateAdapter={AdapterDateFns}>
          <FilterDialog itemType="person" open onClose={onClose} />
        </LocalizationProvider>
      </ThemeProvider>,
    )

    expect(screen.getByTestId('has-groups-0').textContent).toBe('yes')
  })
})
