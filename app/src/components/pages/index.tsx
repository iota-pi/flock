import React, { ReactNode, useMemo } from 'react';
import { Switch, Route } from 'react-router-dom';
import loadable from '@loadable/component';
import { useVault } from '../../state/selectors';
import {
  GeneralIcon,
  GroupsIcon,
  InteractionIcon,
  PersonIcon,
  PrayerIcon,
  SuggestIcon,
} from '../Icons';

const PeoplePage = loadable(() => import('./People'));
const GroupsPage = loadable(() => import('./Groups'));
const EventsPage = loadable(() => import('./General'));
const InteractionsPage = loadable(() => import('./Interactions'));
const SuggestionsPage = loadable(() => import('./Suggestions'));
const PrayerPage = loadable(() => import('./Prayer'));
const LoginPage = loadable(() => import('./Login'));
const CreateAccountPage = loadable(() => import('./CreateAccount'));

export type PageId = (
  'login' |
  'signup' |
  'people' |
  'groups' |
  'general' |
  'interactions' |
  'suggestions' |
  'prayer'
);

export interface InternalPage {
  id: PageId,
  path: string,
  page: ReactNode,
  requiresAuth: boolean,
  dividerBefore?: boolean,
}

export interface Page extends InternalPage {
  name: string,
  icon: ReactNode,
}

export const internalPages: InternalPage[] = [
  {
    id: 'login',
    path: '/login',
    page: <LoginPage />,
    requiresAuth: false,
  },
  {
    id: 'signup',
    path: '/signup',
    page: <CreateAccountPage />,
    requiresAuth: false,
  },
];

export const pages: Page[] = [
  {
    id: 'people',
    path: '/',
    name: 'People',
    icon: <PersonIcon />,
    page: <PeoplePage />,
    requiresAuth: true,
  },
  {
    id: 'groups',
    path: '/groups',
    name: 'Groups',
    icon: <GroupsIcon />,
    page: <GroupsPage />,
    requiresAuth: true,
  },
  {
    id: 'general',
    path: '/general',
    name: 'Prayer Items',
    icon: <GeneralIcon />,
    page: <EventsPage />,
    requiresAuth: true,
  },
  {
    id: 'interactions',
    path: '/interactions',
    name: 'Interactions',
    icon: <InteractionIcon />,
    page: <InteractionsPage />,
    requiresAuth: true,
    dividerBefore: true,
  },
  {
    id: 'suggestions',
    path: '/suggestions',
    name: 'Suggestions',
    icon: <SuggestIcon />,
    page: <SuggestionsPage />,
    requiresAuth: true,
  },
  {
    id: 'prayer',
    path: '/prayer',
    name: 'Prayer Schedule',
    icon: <PrayerIcon />,
    page: <PrayerPage />,
    requiresAuth: true,
  },
];

const allPages: (InternalPage | Page)[] = [
  ...internalPages,
  ...pages.slice().reverse(),
];

function PageView() {
  const vault = useVault();

  const pageRoutes = useMemo(
    () => allPages.map(page => (
      <Route
        key={page.id}
        path={page.path}
      >
        {!page.requiresAuth || vault ? page.page : getPage('login').page}
      </Route>
    )),
    [vault],
  );

  return (
    <Switch>
      {pageRoutes}
    </Switch>
  );
}

export default PageView;

export function getPage(page: PageId) {
  const result = allPages.find(p => p.id === page);
  if (result === undefined) {
    throw new Error(`Unknown page id ${page}`);
  }
  return result;
}
