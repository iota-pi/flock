import { useCallback, useMemo } from 'react';
import { Theme, useMediaQuery } from '@material-ui/core';
import { AutoSizer } from 'react-virtualized';
import { getBlankItem, getItemTypeLabel, Item } from '../../state/items';
import ItemList from '../ItemList';
import {
  useIsActive,
  useItems,
  useMaturity,
  useOptions,
  useSortCriteria,
} from '../../state/selectors';
import BasePage from './BasePage';
import { useAppDispatch, useAppSelector } from '../../store';
import { setUiState, replaceActive, toggleSelected } from '../../state/ui';
import { sortItems } from '../../utils/customSort';
import { filterItems } from '../../utils/customFilter';

export interface Props<T extends Item> {
  itemType: T['type'],
}

function ItemPage<T extends Item>({
  itemType,
}: Props<T>) {
  const dispatch = useAppDispatch();
  const isActive = useIsActive();
  const rawItems = useItems<T>(itemType);
  const selected = useAppSelector(state => state.ui.selected);
  const filters = useAppSelector(state => state.ui.filters);
  const [sortCriteria] = useSortCriteria();
  const [maturity] = useMaturity();
  const { bulkActionsOnMobile } = useOptions();

  const items = useMemo(
    () => {
      const filtered = filterItems(rawItems, filters, maturity);
      const sorted = sortItems(filtered, sortCriteria, maturity);
      return sorted;
    },
    [filters, maturity, rawItems, sortCriteria],
  );

  const hiddenItemCount = rawItems.length - items.length;

  const handleClickItem = useCallback(
    (item: T) => {
      dispatch(replaceActive({ item: item.id }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(replaceActive({ newItem: getBlankItem(itemType) }));
    },
    [dispatch, itemType],
  );
  const handleCheck = useCallback(
    (item: T) => dispatch(toggleSelected(item.id)),
    [dispatch],
  );
  const allSelected = useMemo(
    () => selected.length === items.length && selected.length > 0,
    [items.length, selected.length],
  );
  const handleSelectAll = useCallback(
    () => {
      const newSelected = allSelected ? [] : items.map(item => item.id);
      dispatch(setUiState({ selected: newSelected }));
    },
    [allSelected, dispatch, items],
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
  const getHighlighted = useCallback(
    (item: Item) => isActive(item.id, false),
    [isActive],
  );

  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'));
  const checkboxes = !sm || bulkActionsOnMobile;
  const pluralLabel = getItemTypeLabel(itemType, true);
  const pluralLabelLower = pluralLabel.toLowerCase();
  const maxTags = sm ? 2 : 3;

  const noItemsHint = (
    hiddenItemCount
      ? `Note: ${hiddenItemCount} ${pluralLabelLower} were hidden by filters`
      : 'Click the plus button to add one!'
  );
  const itemCountText = (
    filters.length > 0
      ? `${items.length} / ${rawItems.length} ${pluralLabelLower}`
      : undefined
  );

  return (
    <BasePage
      allSelected={allSelected}
      fab
      fabLabel={`Add ${pluralLabel}`}
      noScrollContainer
      onClickFab={handleClickAdd}
      onSelectAll={checkboxes ? handleSelectAll : undefined}
      topBar
      topBarTitle={itemCountText}
    >
      <AutoSizer disableWidth>
        {({ height }) => (
          <ItemList
            checkboxes={checkboxes}
            disablePadding
            getChecked={getChecked}
            getDescription={getDescription}
            getHighlighted={getHighlighted}
            items={items}
            maxTags={maxTags}
            noItemsHint={noItemsHint}
            noItemsText={`No ${pluralLabelLower} found`}
            onCheck={handleCheck}
            onClick={handleClickItem}
            viewHeight={height}
          />
        )}
      </AutoSizer>
    </BasePage>
  );
}

export default ItemPage;
