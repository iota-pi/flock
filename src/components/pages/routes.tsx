import { lazy } from 'react'
import {
  GroupIcon,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
} from '../Icons'
import { InternalRouteConfig, MenuRouteConfig } from './types'

const CreateAccountPage = lazy(() => import('./CreateAccount'))
const ItemPage = lazy(() => import('./ItemPage'))
const LoginPage = lazy(() => import('./Login'))
const PrayerPage = lazy(() => import('./Prayer'))
const SettingsPage = lazy(() => import('./Settings'))
const WelcomePage = lazy(() => import('./Welcome'))

// Internal routes (not in the main menu)
export const INTERNAL_ROUTES = {
  welcome: {
    path: '/welcome',
    requiresAuth: false,
    page: <WelcomePage />,
  },
  login: {
    path: '/login',
    requiresAuth: false,
    page: <LoginPage />,
  },
  signup: {
    path: '/signup',
    requiresAuth: false,
    page: <CreateAccountPage />,
  },
} as const satisfies Record<string, InternalRouteConfig>

// Main menu routes
export const MENU_ROUTES = {
  prayer: {
    name: 'Prayer',
    icon: PrayerIcon,
    path: '/',
    requiresAuth: true,
    page: <PrayerPage />,
  },
  people: {
    name: 'People',
    icon: PersonIcon,
    path: '/people',
    requiresAuth: true,
    dividerBefore: true,
    page: <ItemPage itemType="person" />,
  },
  groups: {
    name: 'Groups',
    icon: GroupIcon,
    path: '/groups',
    requiresAuth: true,
    page: <ItemPage itemType="group" />,
  },
  settings: {
    name: 'Settings',
    icon: OptionsIcon,
    path: '/settings',
    requiresAuth: true,
    dividerBefore: true,
    noPlaceholderDrawer: true,
    page: <SettingsPage />,
  },
} as const satisfies Record<string, MenuRouteConfig>

export const ROUTES = {
  ...INTERNAL_ROUTES,
  ...MENU_ROUTES,
}

export type InternalPageId = keyof typeof INTERNAL_ROUTES
export type PageId = keyof typeof MENU_ROUTES
export type AnyPageId = InternalPageId | PageId
