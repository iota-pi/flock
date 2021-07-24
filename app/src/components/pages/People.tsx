import React, { useCallback, useMemo } from 'react';
import { compareItems, getBlankPerson, PersonItem } from '../../state/items';
import ItemList from '../ItemList';
import { useIsActive, useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { useAppDispatch } from '../../store';
import { updateActive } from '../../state/ui';


function PeoplePage() {
  const dispatch = useAppDispatch();
  const isActive = useIsActive();
  const rawPeople = useItems<PersonItem>('person');

  const people = useMemo(() => rawPeople.slice().sort(compareItems), [rawPeople]);

  const handleClickPerson = useCallback(
    (item: PersonItem) => () => {
      if (!isActive(item)) {
        dispatch(updateActive({ item }));
      }
    },
    [dispatch, isActive],
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
        getHighlighted={isActive}
        items={people}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No people found"
        onClick={handleClickPerson}
      />
    </BasePage>
  );
}

export default PeoplePage;
