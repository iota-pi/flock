import React, { useCallback, useMemo, useState } from 'react';
import { compareItems, GeneralItem } from '../../state/items';
import ItemList from '../ItemList';
import GeneralDrawer from '../drawers/General';
import { useItems } from '../../state/selectors';
import BasePage from './BasePage';


function GeneralPage() {
  const rawItems = useItems<GeneralItem>('general');
  const items = useMemo(() => rawItems.sort(compareItems), [rawItems]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentItem, setCurrentItem] = useState<GeneralItem>();

  const handleClickItem = useCallback(
    (item: GeneralItem) => () => {
      setShowDetails(true);
      setCurrentItem(item);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentItem(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

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

      <GeneralDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentItem}
      />
    </BasePage>
  );
}

export default GeneralPage;
