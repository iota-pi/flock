import { Divider, Typography } from '@mui/material';
import { Fragment, useCallback, useMemo } from 'react';
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
import PageContainer from '../PageContainer';


function ActionsPage() {
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
          <Fragment key="heading-due">
            <PageContainer maxWidth="xl">
              <Typography variant="h4" fontWeight={300}>
                Due actions
              </Typography>
            </PageContainer>

            <Divider />
          </Fragment>
        ),
        height: 74,
        index: 0,
      },
      {
        content: comingSoonIndex < laterIndex && (
          <Fragment key="heading-soon">
            <PageContainer maxWidth="xl">
              <Typography variant="h4" fontWeight={300}>
                Coming soon
              </Typography>
            </PageContainer>

            <Divider />
          </Fragment>
        ),
        height: 74,
        index: comingSoonIndex,
      },
      {
        content: laterIndex < allActions.length && (
          <Fragment key="heading-later">
            <PageContainer maxWidth="xl">
              <Typography variant="h4" fontWeight={300}>
                Later actions
              </Typography>
            </PageContainer>

            <Divider />
          </Fragment>
        ),
        height: 74,
        index: laterIndex,
      },
    ],
    [allActions.length, laterIndex, comingSoonIndex],
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
