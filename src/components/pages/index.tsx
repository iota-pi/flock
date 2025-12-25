import { lazy, Suspense, useMemo } from 'react'
import { Navigate, useLocation, useRoutes, matchPath } from 'react-router'
import { CircularProgress, Box } from '@mui/material'
import {
  GroupIcon,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
} from '../Icons'
import { useLoggedIn } from '../../state/selectors'
import { InternalPage, Page, AnyPageId } from './types'

const CreateAccountPage = lazy(() => import('./CreateAccount'))
const ItemPage = lazy(() => import('./ItemPage'))
const LoginPage = lazy(() => import('./Login'))
const PrayerPage = lazy(() => import('./Prayer'))
const SettingsPage = lazy(() => import('./Settings'))
const WelcomePage = lazy(() => import('./Welcome'))

export const internalPages: InternalPage[] = [
  {
    id: 'welcome',
    page: <WelcomePage />,
    path: '/welcome',
    requiresAuth: false,
  },
  {
    id: 'login',
    page: <LoginPage />,
    path: '/login',
    requiresAuth: false,
  },
  {
    id: 'signup',
    page: <CreateAccountPage />,
    path: '/signup',
    requiresAuth: false,
  },
]

export const pages: Page[] = [
  {
    icon: PrayerIcon,
    id: 'prayer',
    name: 'Prayer',
    page: <PrayerPage />,
    path: '/',
    requiresAuth: true,
  },
  {
    dividerBefore: true,
    icon: PersonIcon,
    id: 'people',
    name: 'People',
    page: <ItemPage itemType="person" />,
    path: '/people',
    requiresAuth: true,
  },
  {
    icon: GroupIcon,
    id: 'groups',
    name: 'Groups',
    page: <ItemPage itemType="group" />,
    path: '/groups',
    requiresAuth: true,
  },
  {
    dividerBefore: true,
    icon: OptionsIcon,
    id: 'settings',
    name: 'Settings',
    noPlaceholderDrawer: true,
    page: <SettingsPage />,
    path: '/settings',
    requiresAuth: true,
  },
]

const reversedPages = pages.slice().reverse()
const allPages: (InternalPage | Page)[] = [
  ...internalPages,
  ...reversedPages,
]

function Loading() {
  return (
    <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
      <CircularProgress />
    </Box>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const loggedIn = useLoggedIn()
  const location = useLocation()

  if (!loggedIn) {
    return <Navigate to="/welcome" state={{ from: location }} replace />
  }

  return <>{children}</>
}

function PageView() {
  const routes = [
    // Public routes
    ...internalPages.filter(p => !p.requiresAuth).map(page => ({
      path: page.path,
      element: page.page,
    })),
    // Protected routes
    ...pages.map(page => ({
      path: page.path,
      element: (
        <RequireAuth>
          {page.page}
        </RequireAuth>
      ),
    })),
    {
      path: "*",
      element: <Navigate to="/" replace />
    }
  ]

  const element = useRoutes(routes)

  return (
    <Suspense fallback={<Loading />}>
      {element}
    </Suspense>
  )
}

export default PageView

export function getPage(page: AnyPageId) {
  const result = allPages.find(p => p.id === page)
  if (result === undefined) {
    throw new Error(`Unknown page id ${page}`)
  }
  return result
}

export function usePage(): Page | undefined {
  const location = useLocation()
  const page = useMemo(
    () => reversedPages.find(p => matchPath(p.path, location.pathname)),
    [location.pathname],
  )
  return page
}
