import React, { useCallback, useMemo, useState } from 'react';
import { compareItems, PersonItem } from '../../state/items';
import PersonDrawer from '../drawers/Person';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';


function PeoplePage() {
  const rawPeople = useItems<PersonItem>('person');
  const people = useMemo(() => rawPeople.slice().sort(compareItems), [rawPeople]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentPerson, setCurrentPerson] = useState<PersonItem>();

  const handleClickPerson = useCallback(
    (person: PersonItem) => () => {
      setShowDetails(true);
      setCurrentPerson(person);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentPerson(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <BasePage
      fab
      fabLabel="Add Person"
      onClickFab={handleClickAdd}
    >
      <ItemList
        items={people}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No people found"
        onClick={handleClickPerson}
      />

      <PersonDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentPerson}
      />
    </BasePage>
  );
}

export default PeoplePage;
