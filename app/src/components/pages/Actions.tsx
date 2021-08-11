import React, { useCallback, useMemo } from 'react';
import { Container, Divider, makeStyles, Typography } from '@material-ui/core';
import { useItems } from '../../state/selectors';
import { ActionNote, getBlankAction, getNotes } from '../../state/items';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';
import NoteList from '../NoteList';
import { ONE_DAY } from '../../utils/frequencies';
import { isSameDay } from '../../utils';

const useStyles = makeStyles(theme => ({
  container: {
    flexGrow: 1,
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),

    '&:not(:first-child)': {
      marginTop: theme.spacing(2),
    },
  },
  heading: {
    fontWeight: 300,
  },
}));

function ActionsPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();

  const allActions = useMemo(() => {
    const actions = getNotes(items, 'action') as ActionNote[];
    const withTimes: [ActionNote, number][] = actions.map(
      action => [action, action.date - new Date().getTime()],
    );
    withTimes.sort((a, b) => a[1] - b[1]);
    return withTimes.map(([action]) => action);
  }, [items]);
  const todayIndex = useMemo(
    () => allActions.findIndex(
      action => (
        action.date > new Date().getTime() && !isSameDay(new Date(action.date), new Date())
      ),
    ),
    [allActions],
  );
  const comingSoonIndex = useMemo(
    () => allActions.findIndex(
      action => (
        action.date > new Date().getTime() + ONE_DAY * 7
      ),
    ),
    [allActions],
  );
  const todayActions = useMemo(
    () => allActions.slice(0, todayIndex),
    [allActions, todayIndex],
  );
  const comingSoonActions = useMemo(
    () => allActions.slice(todayIndex, comingSoonIndex),
    [allActions, comingSoonIndex, todayIndex],
  );
  const otherActions = useMemo(
    () => allActions.slice(comingSoonIndex),
    [allActions, comingSoonIndex],
  );

  const handleClick = useCallback(
    (note: ActionNote) => () => {
      dispatch(updateActive({ item: note }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => dispatch(updateActive({ item: getBlankAction() })),
    [dispatch],
  );

  return (
    <BasePage
      fab
      fabLabel="Add action"
      onClickFab={handleClickAdd}
    >
      <Container maxWidth="xl" className={classes.container}>
        <Typography variant="h4" className={classes.heading}>
          Due actions
        </Typography>
      </Container>

      <Divider />

      <NoteList
        notes={todayActions}
        noNotesText="No action items due"
        onClick={handleClick}
        showIcons
      />

      <Container maxWidth="xl" className={classes.container}>
        <Typography variant="h4" className={classes.heading}>
          Coming soon actions
        </Typography>
      </Container>

      <Divider />

      <NoteList
        notes={comingSoonActions}
        noNotesText="No action items due"
        onClick={handleClick}
        showIcons
      />

      <Container maxWidth="xl" className={classes.container}>
        <Typography variant="h4" className={classes.heading}>
          Later actions
        </Typography>
      </Container>

      <Divider />

      <NoteList
        notes={otherActions}
        noNotesText="No action items due"
        onClick={handleClick}
        showIcons
      />
    </BasePage>
  );
}

export default ActionsPage;
