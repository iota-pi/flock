import { Fragment, useCallback, useMemo, useState } from 'react'
import { Button, Divider, Grid, Theme, useMediaQuery } from '@mui/material'
import { getBlankItem, getItemTypeLabel, Item } from '../../state/items'
import ItemList from '../../features/items/components/ItemList'
import {
  useIsActive,
  useItems,
  useItemsInitialLoading,
  usePracticalFilterCount,
  useMetadata,
  useSortCriteria,
} from '../../state/selectors'
import BasePage from './BasePage'
import { useUiStore } from '../../state/uiStore'
import { useAsyncItems } from '../../hooks/useAsyncItems'

export interface Props<T extends Item> {
  itemType: T['type'],
}

function ItemPage<T extends Item>({
  itemType,
}: Props<T>) {
  const replaceActive = useUiStore(state => state.replaceActive)
  const setUi = useUiStore(state => state.setUi)
  const toggleSelected = useUiStore(state => state.toggleSelected)
  const isActive = useIsActive()
  const itemsInitialLoading = useItemsInitialLoading()
  const rawItems = useItems<T>(itemType)
  const selected = useUiStore(state => state.selected)
  const filters = useUiStore(state => state.filters)
  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})
  const filterCount = usePracticalFilterCount()
  const [sortCriteria] = useSortCriteria()

  const [showArchived, setShowArchived] = useState(false)
  const handleClickShowArchived = useCallback(
    () => setShowArchived(sa => !sa),
    [],
  )

  const {
    items,
    totalApplicable,
    archivedCount,
  } = useAsyncItems({
    items: rawItems,
    filters,
    sortCriteria,
    showArchived,
  })
  const hiddenItemCount = totalApplicable - items.length

  const handleClickItem = useCallback(
    (item: T) => {
      replaceActive({ item: item.id })
    },
    [replaceActive],
  )
  const handleClickAdd = useCallback(
    () => {
      replaceActive({
        newItem: {
          ...getBlankItem(itemType),
          prayerFrequency: defaultFrequencies?.[itemType] ?? 'none',
        },
      })
    },
    [defaultFrequencies, itemType, replaceActive],
  )
  const handleCheck = useCallback(
    (item: T) => toggleSelected(item.id),
    [toggleSelected],
  )
  const allSelected = useMemo(
    () => selected.length === items.length && selected.length > 0,
    [items.length, selected.length],
  )
  const handleSelectAll = useCallback(
    () => {
      const newSelected = allSelected ? [] : items.map(item => item.id)
      setUi({ selected: newSelected })
    },
    [allSelected, items, setUi],
  )

  const getChecked = useCallback((item: T) => selected.includes(item.id), [selected])
  const getDescription = useCallback(
    (item: T) => {
      if (item.type === 'group') {
        const n = item.members.length
        const s = n !== 1 ? 's' : ''
        const description = item.description ? ` — ${item.description}` : ''
        return `${n} member${s}${description}`
      }
      return item.description
    },
    [],
  )
  const getHighlighted = useCallback(
    (item: Item) => isActive(item.id),
    [isActive],
  )

  const pluralLabel = getItemTypeLabel(itemType, true)
  const pluralLabelLower = pluralLabel.toLowerCase()

  const noItemsHint = (
    itemsInitialLoading
      ? undefined
      : hiddenItemCount
        ? `Note: ${hiddenItemCount} ${pluralLabelLower} were hidden by filters`
        : 'Click the plus button to add one!'
  )
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
        getChecked={getChecked}
        getDescription={getDescription}
        getHighlighted={getHighlighted}
        items={items}
        showTags={useMediaQuery<Theme>(theme => theme.breakpoints.up('sm'))}
        maxTags={3}
        noItemsHint={noItemsHint}
        noItemsText={itemsInitialLoading ? 'Loading items...' : `No ${pluralLabelLower} found`}
        onCheck={handleCheck}
        onClick={handleClickItem}
      />
    </BasePage>
  )
}

export default ItemPage
