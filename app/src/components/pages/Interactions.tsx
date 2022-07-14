import { Divider, Theme, Typography, useMediaQuery } from '@mui/material';
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
import PageContainer from '../PageContainer';


function InteractionsPage() {
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

  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'));
  const maxTags = sm ? 2 : 3;

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <Fragment key="heading-suggestions">
            <PageContainer maxWidth="xl">
              <Typography variant="h4" fontWeight={300}>
                Suggestions
              </Typography>
            </PageContainer>

            <Divider />
          </Fragment>
        ),
        height: 74,
        index: 0,
      },
    ],
    [],
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
