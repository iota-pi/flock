import React, { useCallback, useMemo, useState } from 'react';
import { useItems } from '../../state/selectors';
import ItemList from '../ItemList';
import { PersonItem } from '../../state/items';
import { getInteractionSuggestions, getLastInteractionDate } from '../../utils/interactions';
import PersonDrawer from '../drawers/Person';
import { formatDate } from '../../utils';
import BasePage from './BasePage';


function SuggestionsPage() {
  const people = useItems<PersonItem>('person');

  const [currentItem, setCurrentItem] = useState<PersonItem>(people[0]);
  const [showDrawer, setShowDrawer] = useState(false);

  const suggestions = useMemo(() => getInteractionSuggestions(people), [people]);

  const handleClick = useCallback(
    (item: PersonItem) => () => {
      setCurrentItem(item);
      setShowDrawer(true);
    },
    [],
  );
  const handleClose = useCallback(() => setShowDrawer(false), []);
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
    <BasePage
      drawer={(
        <PersonDrawer
          item={currentItem}
          onClose={handleClose}
          open={showDrawer}
        />
      )}
    >
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
