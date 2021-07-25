import React, { useCallback, useMemo } from 'react';
import { compareItems, getBlankItem, getTypeLabel, Item } from '../../state/items';
import ItemList from '../ItemList';
import { useIsActive, useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { useAppDispatch } from '../../store';
import { updateActive } from '../../state/ui';

export interface Props<T extends Item> {
  itemType: T['type'],
}

function ItemPage<T extends Item>({
  itemType,
}: Props<T>) {
  const dispatch = useAppDispatch();
  const isActive = useIsActive();
  const rawPeople = useItems<T>(itemType);

  const people = useMemo(() => rawPeople.slice().sort(compareItems), [rawPeople]);

  const handleClickItem = useCallback(
    (item: T) => () => {
      if (!isActive(item)) {
        dispatch(updateActive({ item }));
      }
    },
    [dispatch, isActive],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(updateActive({ item: getBlankItem(itemType) }));
    },
    [dispatch, itemType],
  );

  const getDescription = useCallback(
    (item: T) => {
      if (item.type === 'group') {
        const n = item.members.length;
        const s = n !== 1 ? 's' : '';
        const description = item.description ? ` — ${item.description}` : '';
        return `${n} member${s}${description}`;
      }
      return item.description;
    },
    [],
  );

  const pluralLabel = getTypeLabel(itemType, true);

  return (
    <BasePage
      fab
      fabLabel={`Add ${pluralLabel}`}
      onClickFab={handleClickAdd}
    >
      <ItemList
        getDescription={getDescription}
        getHighlighted={isActive}
        items={people}
        noItemsHint="Click the plus button to add one!"
        noItemsText={`No ${pluralLabel.toLowerCase()} found`}
        onClick={handleClickItem}
      />
    </BasePage>
  );
}

export default ItemPage;
