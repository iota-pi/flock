import React, { useCallback, useMemo } from 'react';
import { useItems } from '../../state/selectors';
import ItemList from '../ItemList';
import { PersonItem } from '../../state/items';
import { getInteractionSuggestions, getLastInteractionDate } from '../../utils/interactions';
import { formatDate } from '../../utils';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';


function SuggestionsPage() {
  const dispatch = useAppDispatch();
  const people = useItems<PersonItem>('person');

  const suggestions = useMemo(() => getInteractionSuggestions(people), [people]);

  const handleClick = useCallback(
    (item: PersonItem) => () => {
      dispatch(updateActive({ item }));
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

  return (
    <BasePage>
      <ItemList
        getDescription={getDescription}
        items={suggestions}
        onClick={handleClick}
        noItemsText="Nice! You're all caught up"
      />
    </BasePage>
  );
}

export default SuggestionsPage;
