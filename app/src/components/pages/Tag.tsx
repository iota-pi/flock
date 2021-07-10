import React, { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { compareItems, Item } from '../../state/items';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';
import AnyItemDrawer from '../drawers/AnyItemDrawer';


function TagPage() {
  const tag = decodeURIComponent(useParams<{ tag: string }>().tag);
  const rawItems = useItems();
  const items = useMemo(
    () => rawItems.filter(item => item.tags.includes(tag)).sort(compareItems),
    [rawItems, tag],
  );

  const [showDetails, setShowDetails] = useState(false);
  const [currentItem, setCurrentItem] = useState<Item>();

  const handleClickItem = useCallback(
    (item: Item) => () => {
      setCurrentItem(item);
      setShowDetails(true);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <BasePage>
      <ItemList
        items={items}
        noItemsText="No items found"
        onClick={handleClickItem}
        showIcons
      />

      <AnyItemDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentItem}
      />
    </BasePage>
  );
}

export default TagPage;
