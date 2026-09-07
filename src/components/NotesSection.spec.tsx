import { render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import getTheme from '../theme'
import NotesSection from './NotesSection'
import type { Note } from '../shared/schemas/items'

function renderWithTheme(ui: React.ReactNode) {
  return render(
    <ThemeProvider theme={getTheme(false)}>
      {ui}
    </ThemeProvider>,
  )
}

describe('NotesSection', () => {
  it('displays approaching limit warning when note text reaches 80% (4000 characters)', () => {
    const notes: Note[] = [
      {
        id: 'note-1',
        text: 'N'.repeat(4000),
        archived: false,
        time: Date.now(),
      },
    ]

    renderWithTheme(<NotesSection notes={notes} onChange={() => {}} />)

    expect(screen.getByText(/4000\/5000 characters \(approaching limit\)/)).toBeTruthy()
  })

  it('displays error helper text when note text exceeds 5000 characters', () => {
    const notes: Note[] = [
      {
        id: 'note-1',
        text: 'N'.repeat(5001),
        archived: false,
        time: Date.now(),
      },
    ]

    renderWithTheme(<NotesSection notes={notes} onChange={() => {}} />)

    expect(screen.getByText(/Note must be 5000 characters or less/)).toBeTruthy()
  })

  it('does not display warning helper text when note is well below 80%', () => {
    const notes: Note[] = [
      {
        id: 'note-1',
        text: 'A normal short note',
        archived: false,
        time: Date.now(),
      },
    ]

    renderWithTheme(<NotesSection notes={notes} onChange={() => {}} />)

    expect(screen.queryByText(/\/5000 characters/)).toBeNull()
  })
})
