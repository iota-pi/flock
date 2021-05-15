import React, { ReactNode, useMemo } from 'react';
import { Switch, Route } from 'react-router-dom';
import PersonIcon from '@material-ui/icons/Person';
import GroupsIcon from '@material-ui/icons/GroupWork';
import EventsIcon from '@material-ui/icons/Event';
import InteractionIcon from '@material-ui/icons/QuestionAnswer';
import SuggestIcon from '@material-ui/icons/Update';
import PrayerIcon from '@material-ui/icons/Phone';
import loadable from '@loadable/component';
import { useVault } from '../../state/selectors';
import EventsPage from './Events';

const PeoplePage = loadable(() => import('./People'));
const GroupsPage = loadable(() => import('./Groups'));
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
  'events' |
  'interactions' |
  'suggestions' |
  'prayer'
);

export interface InternalPage {
  id: PageId,
  path: string,
  page: ReactNode,
  requiresAuth: boolean,
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
    id: 'events',
    path: '/events',
    name: 'Events',
    icon: <EventsIcon />,
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
  },
  {
    id: 'prayer',
    path: '/prayer',
    name: 'Prayer',
    icon: <PrayerIcon />,
    page: <PrayerPage />,
    requiresAuth: true,
  },
  {
    id: 'suggestions',
    path: '/suggestions',
    name: 'Suggestions',
    icon: <SuggestIcon />,
    page: <SuggestionsPage />,
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
