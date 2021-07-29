import React, { useCallback, useMemo } from 'react';
import { Theme, useMediaQuery } from '@material-ui/core';
import { compareItems, getBlankItem, getItemTypeLabel, Item } from '../../state/items';
import ItemList from '../ItemList';
import { useIsActive, useItems } from '../../state/selectors';
import BasePage from './BasePage';
import { useAppDispatch, useAppSelector } from '../../store';
import { setUiState, updateActive } from '../../state/ui';

export interface Props<T extends Item> {
  itemType: T['type'],
}

function ItemPage<T extends Item>({
  itemType,
}: Props<T>) {
  const dispatch = useAppDispatch();
  const isActive = useIsActive();
  const rawPeople = useItems<T>(itemType);
  const selected = useAppSelector(state => state.ui.selected);

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
  const handleCheck = useCallback(
    (item: T) => () => {
      const index = selected.indexOf(item.id);
      let newSelected: typeof selected;
      if (index > -1) {
        newSelected = [...selected.slice(0, index), ...selected.slice(index + 1)];
      } else {
        newSelected = [...selected, item.id];
      }
      dispatch(setUiState({ selected: newSelected }));
    },
    [dispatch, selected],
  );

  const getChecked = useCallback((item: T) => selected.includes(item.id), [selected]);
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

  const sm = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));
  const checkboxes = !sm;
  const pluralLabel = getItemTypeLabel(itemType, true);

  return (
    <BasePage
      fab
      fabLabel={`Add ${pluralLabel}`}
      onClickFab={handleClickAdd}
    >
      <ItemList
        checkboxes={checkboxes}
        getChecked={getChecked}
        getDescription={getDescription}
        getHighlighted={isActive}
        items={people}
        noItemsHint="Click the plus button to add one!"
        noItemsText={`No ${pluralLabel.toLowerCase()} found`}
        onCheck={handleCheck}
        onClick={handleClickItem}
      />
    </BasePage>
  );
}

export default ItemPage;
