import { lazy, type ReactNode } from 'react'
import { Box, CircularProgress } from '@mui/material'
import GeneralMessage from '../GeneralMessage'
import AsyncBoundary from '../ui/AsyncBoundary'
import { useLoggedIn } from 'src/state/selectors'
import { useDataStore } from 'src/state/dataStore'

const DrawerDisplay = lazy(() => import('./DrawerDisplay'))
const SelectedActions = lazy(() => import('../SelectedActions'))

function MainLayout({ children }: { children: ReactNode }) {
  const loggedIn = useLoggedIn()
  const dataStatus = useDataStore(state => state.status)

  let content = children
  if (loggedIn && dataStatus === 'initializing') {
    content = (
      <Box sx={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Box
      sx={{
        display: "flex",
        flexGrow: 1,
        overflow: "hidden"
      }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          position: "relative"
        }}>
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            overflow: "hidden",
            position: "relative"
          }}>
          {content}
        </Box>

        <Box
          sx={{
            flexShrink: 0,
            overflow: "hidden"
          }}>
          <AsyncBoundary loadingFallback={null}>
            <SelectedActions />
          </AsyncBoundary>
        </Box>
      </Box>
      {loggedIn && (
        <AsyncBoundary loadingFallback={null}>
          <DrawerDisplay />
        </AsyncBoundary>
      )}
      <GeneralMessage />
    </Box>
  )
}

export default MainLayout
