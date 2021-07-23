import React, { useCallback, useMemo } from 'react';
import { compareItems, GeneralItem, getBlankGeneral } from '../../state/items';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';


function GeneralPage() {
  const dispatch = useAppDispatch();
  const rawItems = useItems<GeneralItem>('general');

  const items = useMemo(() => rawItems.sort(compareItems), [rawItems]);

  const handleClickItem = useCallback(
    (item: GeneralItem) => () => {
      dispatch(updateActive({ item }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(updateActive({ item: getBlankGeneral() }));
    },
    [dispatch],
  );

  return (
    <BasePage
      fab
      fabLabel="Add Prayer Item"
      onClickFab={handleClickAdd}
    >
      <ItemList
        items={items}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No items found"
        onClick={handleClickItem}
      />
    </BasePage>
  );
}

export default GeneralPage;
