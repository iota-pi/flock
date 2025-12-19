import { useMemo } from 'react'
import { Routes, Route, matchPath, useLocation } from 'react-router'
import loadable from '@loadable/component'
import {
  GroupIcon,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
} from '../Icons'
import { useLoggedIn } from '../../state/selectors'
import { InternalPage, Page, AnyPageId } from './types'

const CreateAccountPage = loadable(() => import('./CreateAccount'))
const ItemPage = loadable(() => import('./ItemPage'))
const LoginPage = loadable(() => import('./Login'))
const PrayerPage = loadable(() => import('./Prayer'))
const SettingsPage = loadable(() => import('./Settings'))
const WelcomePage = loadable(() => import('./Welcome'))

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

function PageView() {
  const loggedIn = useLoggedIn()

  const pageRoutes = useMemo(
    () => allPages.map(page => (
      <Route
        key={page.id}
        path={page.path}
        element={(
          !page.requiresAuth || loggedIn
            ? page.page
            : getPage('welcome').page
        )}
      />
    )),
    [loggedIn],
  )

  return (
    <Routes>
      {pageRoutes}
    </Routes>
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

export function usePage() {
  const location = useLocation()
  const page = useMemo(
    () => reversedPages.find(p => matchPath(location.pathname, p.path)),
    [location.pathname],
  )
  return page
}
