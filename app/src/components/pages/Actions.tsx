import React, { useCallback, useMemo } from 'react';
import { Container, Divider, makeStyles, Typography } from '@material-ui/core';
import { useItems } from '../../state/selectors';
import { ActionNote, getBlankAction, getNotes } from '../../state/items';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';
import NoteList from '../NoteList';

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

  const actions = useMemo(() => getNotes(items, 'action') as ActionNote[], [items]);

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
          Due Actions
        </Typography>
      </Container>

      <Divider />

      <NoteList
        notes={actions}
        noNotesText="No action items due"
        onClick={handleClick}
        showIcons
      />
    </BasePage>
  );
}

export default ActionsPage;
