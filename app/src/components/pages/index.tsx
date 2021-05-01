import React, { ReactNode, useMemo } from 'react';
import { Switch, Route } from 'react-router-dom';
import PersonIcon from '@material-ui/icons/Person';
import GroupsIcon from '@material-ui/icons/GroupWork';
import InteractionIcon from '@material-ui/icons/QuestionAnswer';
import SuggestIcon from '@material-ui/icons/Update';
import PrayerIcon from '@material-ui/icons/Phone';
import loadable from '@loadable/component';

const PeoplePage = loadable(() => import('./People'));
const GroupsPage = loadable(() => import('./Groups'));
const InteractionsPage = loadable(() => import('./Interactions'));
const SuggestionsPage = loadable(() => import('./Suggestions'));
const PrayerPage = loadable(() => import('./Prayer'));
const LoginPage = loadable(() => import('./Login'));

export interface InternalPage {
  id: string,
  path: string,
  page: ReactNode,
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
  },
];

export const pages: Page[] = [
  {
    id: 'people',
    path: '/',
    name: 'People',
    icon: <PersonIcon />,
    page: <PeoplePage />,
  },
  {
    id: 'groups',
    path: '/groups',
    name: 'Groups',
    icon: <GroupsIcon />,
    page: <GroupsPage />,
  },
  {
    id: 'interactions',
    path: '/interactions',
    name: 'Interactions',
    icon: <InteractionIcon />,
    page: <InteractionsPage />,
  },
  {
    id: 'suggestions',
    path: '/suggestions',
    name: 'Suggestions',
    icon: <SuggestIcon />,
    page: <SuggestionsPage />,
  },
  {
    id: 'prayer',
    path: '/prayer',
    name: 'Prayer',
    icon: <PrayerIcon />,
    page: <PrayerPage />,
  },
];

function PageView() {
  const pageRoutes = useMemo(
    () => {
      const allPages = [
        ...internalPages,
        ...pages.slice().reverse(),
      ];
      return allPages.map(page => (
        <Route
          key={page.id}
          path={page.path}
        >
          {page.page}
        </Route>
      ));
    },
    [],
  );

  return (
    <Switch>
      {pageRoutes}
    </Switch>
  );
}

export default PageView;
