import { Fragment, useCallback, useMemo, useState } from 'react'
import { Button, Divider, Grid, Theme, useMediaQuery } from '@mui/material'
import { DeleteIcon } from 'src/components/Icons'
import { ERROR_ITEM_TYPE, getItemTypeLabel, Item } from 'src/state/items'
import type { ItemType } from 'src/shared/itemTypes'
import ItemList from 'src/features/items/components/ItemList'
import {
  useItems,
  usePracticalFilterCount,
  useMetadata,
  useSortCriteria,
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
  const replaceActive = useNavigationStore(state => state.replaceActive)
  const setSelected = useNavigationStore(state => state.setSelected)
  const toggleSelected = useNavigationStore(state => state.toggleSelected)
  const allItems = useItems()
  const rawItems = useMemo(
    () => allItems.filter(item => (
      item.type === itemType
      || (item.type === ERROR_ITEM_TYPE && item.originalType === itemType)
    )),
    [allItems, itemType],
  )
  const selected = useNavigationStore(state => state.selected)
  const filters = useUiStore(state => state.filters)
  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})
  const filterCount = usePracticalFilterCount()
  const [sortCriteria] = useSortCriteria()

  const [showArchived, setShowArchived] = useState(false)

  const {
    results: items,
    totalApplicable,
    archivedCount,
  } = useMemo(
     () => (
      processItemsSnapshot({
        items: rawItems,
        filters,
        sortCriteria,
        showArchived: false,
      })
    ),
    [rawItems, filters, sortCriteria],
  )

  const handleClickShowArchived = useCallback(
    () => setShowArchived(sa => !sa),
    [],
  )

  const hiddenItemCount = totalApplicable - items.length

  const handleClickItem = useCallback(
    (item: Item) => {
      if (item.type === ERROR_ITEM_TYPE) {
        return
      }

      replaceActive({ item: item.id })
    },
    [replaceActive],
  )
  const handleClickAdd = useCallback(
    () => {
      void createItem(itemType, {
        prayerFrequency: defaultFrequencies?.[itemType] ?? 'none',
      }).then(createdItem => {
        replaceActive({ item: createdItem.id })
      }).catch(error => {
        console.error(error)
      })
    },
    [defaultFrequencies, itemType, replaceActive],
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

  const noItemsHint = hiddenItemCount
    ? `Note: ${hiddenItemCount} ${pluralLabelLower} were hidden by filters`
    : 'Click the plus button to add one!'
  const itemCountText = (
    filterCount > 0
      ? `${items.length} / ${rawItems.length} ${pluralLabelLower}`
      : `${items.length} ${pluralLabelLower}`
  )

  const extras = useMemo(
    () => {
      return [
        {
          content: (
            <Fragment key="show-archived">
              <Divider />

              <Grid container spacing={2} padding={2}>
                <Grid
                  size={{ xs: 12 }}
                  display="flex"
                  sx={{
                    justifyContent: 'center',
                  }}
                >
                  <Button
                    onClick={handleClickShowArchived}
                    variant="outlined"
                    disabled={archivedCount === 0}
                  >
                    {showArchived ? 'Hide' : 'Show'}
                    {' '}
                    Archived {pluralLabel}
                  </Button>
                </Grid>
              </Grid>
            </Fragment>
          ),
          height: 68.5,
          index: -1,
        }
      ]
    },
    [archivedCount, handleClickShowArchived, pluralLabel, showArchived],
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
      showSort
      topBar
      topBarTitle={itemCountText}
    >
      <ItemList
        key={itemType}
        defaultRowHeight={itemType === 'group' ? 72 : undefined}
        checkboxes
        disablePadding
        extraElements={extras}
        getActionIcon={getActionIcon}
        getChecked={getChecked}
        onClickAction={handleClickAction}
        getDescription={getDescription}
        items={items}
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
