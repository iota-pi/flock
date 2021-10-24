import { Container, Divider, Typography } from '@material-ui/core';
import makeStyles from '@material-ui/styles/makeStyles';
import { useCallback, useMemo } from 'react';
import { AutoSizer } from 'react-virtualized';
import { useItems } from '../../state/selectors';
import { ActionNote, getBlankAction, getNotes } from '../../state/items';
import BasePage from './BasePage';
import { replaceActive } from '../../state/ui';
import { useAppDispatch } from '../../store';
import NoteList from '../NoteList';
import { ONE_DAY } from '../../utils/frequencies';
import { isSameDay } from '../../utils';
import { ItemListExtraElement } from '../ItemList';

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
    const unfinishedActions = actions.filter(a => !a.completed);
    const withTimes: [ActionNote, number][] = unfinishedActions.map(
      action => [action, action.date - new Date().getTime()],
    );
    withTimes.sort((a, b) => a[1] - b[1]);
    return withTimes.map(([action]) => action);
  }, [items]);
  const comingSoonIndex = useMemo(
    () => {
      const index = allActions.findIndex(
        action => (
          action.date > new Date().getTime()
          && !isSameDay(new Date(action.date), new Date())
        ),
      );
      return index > -1 ? index : allActions.length;
    },
    [allActions],
  );
  const laterIndex = useMemo(
    () => {
      const index = allActions.findIndex(
        action => action.date > new Date().getTime() + ONE_DAY * 7,
      );
      return index > -1 ? index : allActions.length;
    },
    [allActions],
  );

  const handleClick = useCallback(
    (note: ActionNote) => {
      dispatch(replaceActive({ item: note.id }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => dispatch(replaceActive({ newItem: getBlankAction() })),
    [dispatch],
  );

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <>
            <Container maxWidth="xl" className={classes.container}>
              <Typography variant="h4" className={classes.heading}>
                Due actions
              </Typography>
            </Container>

            <Divider />
          </>
        ),
        height: 74,
        index: 0,
      },
      {
        content: comingSoonIndex < laterIndex && (
          <>
            <Container maxWidth="xl" className={classes.container}>
              <Typography variant="h4" className={classes.heading}>
                Coming soon
              </Typography>
            </Container>

            <Divider />
          </>
        ),
        height: 74,
        index: comingSoonIndex,
      },
      {
        content: laterIndex < allActions.length && (
          <>
            <Container maxWidth="xl" className={classes.container}>
              <Typography variant="h4" className={classes.heading}>
                Later actions
              </Typography>
            </Container>

            <Divider />
          </>
        ),
        height: 74,
        index: laterIndex,
      },
    ],
    [allActions.length, classes, laterIndex, comingSoonIndex],
  );

  return (
    <BasePage
      fab
      fabLabel="Add action"
      onClickFab={handleClickAdd}
    >
      <AutoSizer disableWidth>
        {({ height }) => (
          <NoteList
            extraElements={extraElements}
            notes={allActions}
            onClick={handleClick}
            noNotesText="No action items due"
            showIcons
            viewHeight={height}
          />
        )}
      </AutoSizer>
    </BasePage>
  );
}

export default ActionsPage;
