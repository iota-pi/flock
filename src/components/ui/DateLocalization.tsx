import { ReactNode } from 'react'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'

/**
 * Date picker setup. Wrap each picker in this rather than the whole app, so the date picker library
 * stays out of the first page load.
 */
export default function DateLocalization({ children }: { children: ReactNode }) {
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      {children}
    </LocalizationProvider>
  )
}
