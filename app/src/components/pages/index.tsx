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
  PrayerPointIcon,
  SuggestIcon,
} from '../Icons';

const PeoplePage = loadable(() => import('./People'));
const GroupsPage = loadable(() => import('./Groups'));
const GeneralPage = loadable(() => import('./General'));
const PrayerPointsPage = loadable(() => import('./PrayerPoints'));
const InteractionsPage = loadable(() => import('./Interactions'));
const SuggestionsPage = loadable(() => import('./Suggestions'));
const PrayerPage = loadable(() => import('./Prayer'));
const LoginPage = loadable(() => import('./Login'));
const CreateAccountPage = loadable(() => import('./CreateAccount'));
const TagPage = loadable(() => import('./Tag'));

export type PageId = (
  'login' |
  'signup' |
  'people' |
  'groups' |
  'general' |
  'prayer-points' |
  'interactions' |
  'prayer' |
  'suggestions' |
  'tag'
);

export interface InternalPage {
  id: PageId,
  path: string,
  page: ReactNode,
  requiresAuth: boolean,
  dividerBefore?: boolean,
  visible?: boolean,
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
  {
    id: 'tag',
    path: '/tag/:tag',
    page: <TagPage />,
    requiresAuth: true,
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
    name: 'Other Items',
    icon: <GeneralIcon />,
    page: <GeneralPage />,
    requiresAuth: true,
  },
  {
    id: 'prayer-points',
    path: '/prayer-points',
    name: 'Prayer Points',
    icon: <PrayerPointIcon />,
    page: <PrayerPointsPage />,
    requiresAuth: true,
    dividerBefore: true,
  },
  {
    id: 'prayer',
    path: '/prayer',
    name: 'Prayer Schedule',
    icon: <PrayerIcon />,
    page: <PrayerPage />,
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

export function getTagPage(tag: string) {
  return getPage('tag').path.replace(':tag', tag);
}
