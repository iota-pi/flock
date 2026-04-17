import { lazy, type ReactNode } from 'react'
import { Box } from '@mui/material'
import GeneralMessage from '../GeneralMessage'
import { useLoggedIn } from '../../state/selectors'
import AsyncBoundary from '../ui/AsyncBoundary'

const DrawerDisplay = lazy(() => import('./DrawerDisplay'))
const SelectedActions = lazy(() => import('../SelectedActions'))

function MainLayout({ children }: { children: ReactNode }) {
  const loggedIn = useLoggedIn()

  return (
    <Box
      display="flex"
      flexGrow={1}
      overflow="hidden"
    >
      <Box
        display="flex"
        flexDirection="column"
        flexGrow={1}
        position="relative"
      >
        <Box
          display="flex"
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
          position="relative"
        >
          {children}
        </Box>

        <Box flexShrink={0} overflow="hidden">
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
