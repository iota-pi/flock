import { ReactNode } from 'react'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'

type AppProvidersProps = {
  children: ReactNode
}

export default function AppProviders({ children }: AppProvidersProps) {
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      {children}
    </LocalizationProvider>
  )
}

