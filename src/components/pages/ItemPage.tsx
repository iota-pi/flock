import { useCallback, useLayoutEffect, useMemo } from 'react'
import { Theme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { getItemTypeLabel, Item } from 'src/state/items'
import type { ItemType } from 'src/shared/itemTypes'
import ItemList from 'src/features/items/components/ItemList'
import {
  usePracticalFilterCount,
  useGroupLookupMap,
  useMetadata,
  useSortCriteria,
  useItemsOfType,
} from 'src/state/selectors'
import BasePage from './BasePage'
import { useAppStore } from 'src/state/store'
import { createItem } from 'src/features/items/mutations/itemMutations'
import { filterItems } from 'src/utils/customFilter'
import { sortItems } from 'src/utils/customSort'
import { ERROR_ITEM_TYPE } from 'src/shared/schemas/items'


interface Props {
  itemType: ItemType,
}

function ItemPage({
  itemType,
}: Props) {
  const setDrawer = useAppStore(state => state.setDrawer)
  const setSelected = useAppStore(state => state.setSelected)
  const toggleSelected = useAppStore(state => state.toggleSelected)
  const rawItems = useItemsOfType(itemType)
  const groupsByMemberId = useGroupLookupMap()
  const selected = useAppStore(state => state.selected)
  const showArchived = useAppStore(state => state.showArchived)
  const filters = useAppStore(state => state.filters)
  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})
  const filterCount = usePracticalFilterCount()
  const [sortCriteria] = useSortCriteria()
  const totalApplicable = rawItems.length

  const items = useMemo(
    () => {
      const nonArchived = showArchived ? rawItems : rawItems.filter(item => !item.archived)
      const filtered = filterItems(nonArchived, filters, groupsByMemberId)
      const results = sortItems(filtered, sortCriteria)
      return results
    },
    [rawItems, showArchived, filters, groupsByMemberId, sortCriteria],
  )

  const hiddenItemCount = totalApplicable - items.length
  const itemIdsInList = useMemo(() => items.map(item => item.id), [items])
  const visibleItemIdSet = useMemo(() => new Set(itemIdsInList), [itemIdsInList])

  useLayoutEffect(() => {
    if (selected.length === 0) {
      return
    }

    const refinedSelected = selected.filter(id => visibleItemIdSet.has(id))
    if (refinedSelected.length !== selected.length) {
      setSelected(refinedSelected)
    }
  }, [selected, setSelected, visibleItemIdSet])

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

  const itemsMap = useAppStore(state => state.items)
  const getChecked = useCallback((item: Item) => selected.includes(item.id), [selected])
  const getDescription = useCallback(
    (item: Item) => {
      if (item.type === 'group') {
        const activeMembers = item.members.filter(id => {
          const member = itemsMap[id]
          return member && !member.archived && !member.deleted
        })
        const n = activeMembers.length
        const s = n !== 1 ? 's' : ''
        const description = item.description ? ` — ${item.description}` : ''
        return `${n} member${s}${description}`
      }

      if (item.type === ERROR_ITEM_TYPE) {
        return 'Item unavailable due to format error. See Settings > Corrupted Data Recovery to manage.'
      }

      return item.description
    },
    [itemsMap],
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
      itemType={itemType}
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
        getChecked={getChecked}
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
