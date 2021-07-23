import React, { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { compareItems, Item } from '../../state/items';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { useAppDispatch } from '../../store';
import { updateActive } from '../../state/ui';


function TagPage() {
  const dispatch = useAppDispatch();
  const rawItems = useItems();
  const tag = decodeURIComponent(useParams<{ tag: string }>().tag);

  const items = useMemo(
    () => rawItems.filter(item => item.tags.includes(tag)).sort(compareItems),
    [rawItems, tag],
  );

  const handleClickItem = useCallback(
    (item: Item) => () => {
      dispatch(updateActive({ item }));
    },
    [dispatch],
  );

  return (
    <BasePage>
      <ItemList
        items={items}
        noItemsText="No items found"
        onClick={handleClickItem}
        showIcons
      />
    </BasePage>
  );
}

export default TagPage;
