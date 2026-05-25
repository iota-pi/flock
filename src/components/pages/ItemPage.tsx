import { useCallback, useMemo } from 'react'
import { Theme, useMediaQuery } from '@mui/material'
import { DeleteIcon } from 'src/components/Icons'
import { getItemTypeLabel, Item } from 'src/state/items'
import { ERROR_ITEM_TYPE, type ItemType } from 'src/shared/itemTypes'
import ItemList from 'src/features/items/components/ItemList'
import {
  useItemIds,
  usePracticalFilterCount,
  useMetadata,
  useSortCriteria,
  useItemsByIds,
} from 'src/state/selectors'
import BasePage from './BasePage'
import { useUiStore } from 'src/state/uiStore'
import { useNavigationStore } from 'src/state/navigationStore'
import {
  processItemsSnapshot,
} from 'src/workers/itemWorkerManager'
import { createItem, hardDeleteItems } from 'src/features/items/mutations/itemMutations'

interface Props {
  itemType: ItemType,
}

function ItemPage({
  itemType,
}: Props) {
  const setDrawer = useNavigationStore(state => state.setDrawer)
  const setSelected = useNavigationStore(state => state.setSelected)
  const toggleSelected = useNavigationStore(state => state.toggleSelected)
  const itemIds = useItemIds(itemType)
  const rawItems = useItemsByIds(itemIds)
  const selected = useNavigationStore(state => state.selected)
  const filters = useUiStore(state => state.filters)
  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})
  const filterCount = usePracticalFilterCount()
  const [sortCriteria] = useSortCriteria()

  const {
    results: items,
    totalApplicable,
  } = useMemo(
    () => (
      processItemsSnapshot({
        items: rawItems,
        filters,
        sortCriteria,
      })
    ),
    [rawItems, filters, sortCriteria],
  )

  const hiddenItemCount = totalApplicable - items.length
  const itemIdsInList = useMemo(() => items.map(item => item.id), [items])

  const handleClickItem = useCallback(
    (item: Item) => {
      if (item.type === ERROR_ITEM_TYPE) {
        return
      }

      setDrawer({ item: item.id })
    },
    [setDrawer],
  )
  const handleClickAdd = useCallback(
    () => {
      void createItem(itemType, {
        prayerFrequency: defaultFrequencies?.[itemType] ?? 'none',
      }).then(createdItem => {
        setDrawer({ item: createdItem.id })
      }).catch(error => {
        console.error(error)
      })
    },
    [defaultFrequencies, itemType, setDrawer],
  )
  const handleCheck = useCallback(
    (item: Item) => toggleSelected(item.id),
    [toggleSelected],
  )
  const allSelected = useMemo(
    () => selected.length === items.length && selected.length > 0,
    [items.length, selected.length],
  )
  const handleSelectAll = useCallback(
    () => {
      const newSelected = allSelected ? [] : items.map(item => item.id)
      setSelected(newSelected)
    },
    [allSelected, items, setSelected],
  )

  const getChecked = useCallback((item: Item) => selected.includes(item.id), [selected])
  const getDescription = useCallback(
    (item: Item) => {
      if (item.type === 'group') {
        const n = item.members.length
        const s = n !== 1 ? 's' : ''
        const description = item.description ? ` — ${item.description}` : ''
        return `${n} member${s}${description}`
      }

      if (item.type === ERROR_ITEM_TYPE) {
        return 'Item unavailable due to data error. Use hard-delete to remove it.'
      }

      return item.description
    },
    [],
  )
  const getActionIcon = useCallback(
    (item: Item) => (item.type === ERROR_ITEM_TYPE ? <DeleteIcon /> : undefined),
    [],
  )

  const handleClickAction = useCallback(
    (item: Item) => {
      if (item.type !== ERROR_ITEM_TYPE) {
        return
      }

      void hardDeleteItems(item.id).catch(error => {
        console.error(error)
      })
    },
    [],
  )

  const pluralLabel = getItemTypeLabel(itemType, true)
  const pluralLabelLower = pluralLabel.toLowerCase()

  const noItemsHint = (filterCount > 0 && hiddenItemCount > 0)
    ? `Note: ${hiddenItemCount} ${pluralLabelLower} were hidden by filters`
    : 'Click the plus button to add one!'
  const itemCountText = (
    filterCount > 0
      ? `${items.length} / ${rawItems.length} ${pluralLabelLower}`
      : `${items.length} ${pluralLabelLower}`
  )

  return (
    <BasePage
      allSelected={allSelected}
      fab
      fabLabel={`Add ${pluralLabel}`}
      noScrollContainer
      onClickFab={handleClickAdd}
      onSelectAll={handleSelectAll}
      showFilter
      showLoading={false}
      showSort
      topBar
      topBarTitle={itemCountText}
    >
      <ItemList
        key={itemType}
        defaultRowHeight={itemType === 'group' ? 72 : undefined}
        checkboxes
        disablePadding
        getActionIcon={getActionIcon}
        getChecked={getChecked}
        onClickAction={handleClickAction}
        getDescription={getDescription}
        itemIds={itemIdsInList}
        showTags={useMediaQuery<Theme>(theme => theme.breakpoints.up('sm'))}
        maxTags={3}
        noItemsHint={noItemsHint}
        noItemsText={`No ${pluralLabelLower} found`}
        onCheck={handleCheck}
        onClick={handleClickItem}
      />
    </BasePage>
  )
}

export default ItemPage
