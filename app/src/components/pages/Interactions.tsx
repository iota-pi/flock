import { Container, Divider, Theme, Typography, useMediaQuery } from '@material-ui/core';
import makeStyles from '@material-ui/styles/makeStyles';
import { Fragment, useCallback, useMemo } from 'react';
import { AutoSizer } from 'react-virtualized';
import { useItems } from '../../state/selectors';
import ItemList, { ItemListExtraElement } from '../ItemList';
import { getBlankInteraction, PersonItem } from '../../state/items';
import { getInteractionSuggestions, getLastInteractionDate } from '../../utils/interactions';
import { formatDate } from '../../utils';
import BasePage from './BasePage';
import { replaceActive } from '../../state/ui';
import { useAppDispatch } from '../../store';

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

function InteractionsPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const people = useItems<PersonItem>('person');

  const suggestions = useMemo(() => getInteractionSuggestions(people), [people]);

  const handleClick = useCallback(
    (item: PersonItem) => {
      dispatch(replaceActive({ item: item.id }));
    },
    [dispatch],
  );
  const getDescription = useCallback(
    (item: PersonItem) => {
      const interactionDate = getLastInteractionDate(item);
      if (interactionDate) {
        return `Last interaction: ${formatDate(new Date(interactionDate))}`;
      }
      return '';
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => dispatch(replaceActive({ newItem: getBlankInteraction() })),
    [dispatch],
  );

  const sm = useMediaQuery((theme: Theme) => theme.breakpoints.down('md'));
  const maxTags = sm ? 2 : 3;

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <Fragment key="heading-suggestions">
            <Container maxWidth="xl" className={classes.container}>
              <Typography variant="h4" className={classes.heading}>
                Suggestions
              </Typography>
            </Container>

            <Divider />
          </Fragment>
        ),
        height: 74,
        index: 0,
      },
    ],
    [classes],
  );

  return (
    <BasePage
      fab
      fabLabel="Add interaction"
      onClickFab={handleClickAdd}
    >
      <AutoSizer disableWidth>
        {({ height }) => (
          <ItemList
            extraElements={extraElements}
            getDescription={getDescription}
            items={suggestions}
            maxTags={maxTags}
            noItemsText="Nice! You're all caught up"
            onClick={handleClick}
            showIcons
            viewHeight={height}
          />
        )}
      </AutoSizer>
    </BasePage>
  );
}

export default InteractionsPage;
