import { useCallback, useEffect, useState } from 'react'
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router'
import { styled, Toolbar, useMediaQuery } from '@mui/material'
import { Theme } from '@mui/material/styles'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import AppBar from './components/layout/AppBar'
import MainMenu from './components/layout/MainMenu'
import { routes } from './components/pages'
import { useLoggedIn } from './state/selectors'
import { useAuthStore } from './state/authStore'
import { useUiStore } from './state/uiStore'
import MainLayout from './components/layout/MainLayout'
import { loadVault } from './api/vault'
import ErrorPage from './components/pages/ErrorPage'
import { getApiAuthToken } from './api/runtime'
import { trpc } from './api/trpc'
import { queryClient, queryKeys } from './api/queryClient'
import type { Item } from './state/items'
import {
  initialiseDeadLetterQueueCount,
  processOfflineQueue,
  startOfflineQueueHealthMonitor,
} from './sync/offlineQueue'
import {
  startRealtimeCoordinator,
  stopRealtimeCoordinator,
} from './api/realtimeCoordinator'
import { processRealtimeItemEvents } from './api/itemReadService'
import type { RealtimeEventEnvelope } from './shared/realtime'
import {
  subscribeSyncRuntime,
  subscribeSyncRuntimeMessages,
} from './sync/syncRuntime'

const Root = styled('div')({
  display: 'flex',
  height: '100vh',
})
const Content = styled('div')({
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
})

function RootLayout() {
  const trpcUtils = trpc.useUtils()
  const loggedIn = useLoggedIn()
  const account = useAuthStore(state => state.account)
  const setUi = useUiStore(state => state.setUi)
  const setMessage = useUiStore(state => state.setMessage)
  const small = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'))

  const [rawMiniMenu, setMiniMenu] = useState<boolean>()
  const [rawOpenMenu, setOpenMenu] = useState<boolean>()
  const defaultMini = small
  const defaultOpen = !xs
  const miniMenu = rawMiniMenu === undefined ? defaultMini : rawMiniMenu
  const openMenu = rawOpenMenu === undefined ? defaultOpen : rawOpenMenu

  const handleToggleMiniMenu = useCallback(
    () => setMiniMenu(m => (
      m !== undefined && miniMenu !== defaultMini ? undefined : !miniMenu
    )),
    [defaultMini, miniMenu],
  )
  const handleToggleShowMenu = useCallback(
    () => setOpenMenu(o => (
      o !== undefined && openMenu !== defaultOpen ? undefined : !openMenu
    )),
    [defaultOpen, openMenu],
  )
  const handleMenuClick = useCallback(
    () => {
      if (xs) {
        setOpenMenu(undefined)
      }
    },
    [xs],
  )

  useEffect(
    () => {
      const unsubscribeSyncState = subscribeSyncRuntime(syncState => {
        setUi({
          isSyncing: syncState.isSyncing,
          offlineQueueLength: syncState.offlineQueueLength,
          dlqCount: syncState.dlqCount,
        })
      })

      const unsubscribeSyncMessages = subscribeSyncRuntimeMessages(event => {
        setMessage({
          severity: event.severity,
          message: event.message,
        })
      })

      const handleOnline = () => {
        void processOfflineQueue()
      }

      void (async () => {
        await loadVault()
        await initialiseDeadLetterQueueCount()
        startOfflineQueueHealthMonitor()
        await processOfflineQueue()
      })()

      window.addEventListener('online', handleOnline)

      return () => {
        window.removeEventListener('online', handleOnline)
        unsubscribeSyncState()
        unsubscribeSyncMessages()
      }
    },
    [setMessage, setUi],
  )

  const handleRealtimeEvent = useCallback((event: RealtimeEventEnvelope) => {
    if (event.eventType === 'metadata.updated') {
      void trpcUtils.accounts.getMetadata.invalidate()
    }
  }, [trpcUtils])

  useEffect(() => {
    if (!loggedIn || !account) {
      stopRealtimeCoordinator()
      return
    }

    let started = false

    const tryStartRealtime = () => {
      if (started) {
        return
      }

      const token = getApiAuthToken()
      if (!token) {
        return
      }

      startRealtimeCoordinator({
        account,
        onServerEvent: handleRealtimeEvent,
        onItemEvents: events => {
          void processRealtimeItemEvents(events)
        },
        onItemsChanged: ({ updatedItemIds, deletedItemIds }) => {
          if (deletedItemIds.length > 0) {
            queryClient.setQueryData<Item[]>(queryKeys.items, old => {
              if (!old) {
                return old
              }
              const deletedIdSet = new Set(deletedItemIds)
              return old.filter(item => !deletedIdSet.has(item.id))
            })
          }
        },
      })
      started = true
    }

    tryStartRealtime()
    const intervalId = window.setInterval(tryStartRealtime, 500)

    return () => {
      window.clearInterval(intervalId)
      stopRealtimeCoordinator()
    }
  }, [account, handleRealtimeEvent, loggedIn, trpcUtils])

  return (
    <Root>
      {loggedIn && (
        <>
          <AppBar
            minimisedMenu={miniMenu}
            onToggleMenu={handleToggleShowMenu}
          />
          <MainMenu
            minimised={miniMenu}
            open={openMenu}
            onClick={handleMenuClick}
            onMinimise={handleToggleMiniMenu}
          />
        </>
      )}

      <Content>
        {loggedIn && (
          <Toolbar />
        )}

        <MainLayout>
          <Outlet />
        </MainLayout>
      </Content>
    </Root>
  )
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: routes,
  }
])

export default function App() {
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <RouterProvider router={router} />
    </LocalizationProvider>
  )
}
