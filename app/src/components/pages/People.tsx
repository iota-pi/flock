import React, { useCallback, useMemo } from 'react';
import { compareItems, getBlankPerson, PersonItem } from '../../state/items';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { useAppDispatch } from '../../store';
import { updateActive } from '../../state/ui';


function PeoplePage() {
  const dispatch = useAppDispatch();
  const rawPeople = useItems<PersonItem>('person');

  const people = useMemo(() => rawPeople.slice().sort(compareItems), [rawPeople]);

  const handleClickPerson = useCallback(
    (person: PersonItem) => () => {
      dispatch(updateActive({ item: person }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(updateActive({ item: getBlankPerson() }));
    },
    [dispatch],
  );

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
    </BasePage>
  );
}

export default PeoplePage;
