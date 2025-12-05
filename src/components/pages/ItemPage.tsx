import { Fragment, useCallback, useMemo, useState } from 'react'
import { Button, Divider, Grid, Theme, useMediaQuery } from '@mui/material'
import { getBlankItem, getItemTypeLabel, Item } from '../../state/items'
import ItemList from '../ItemList'
import {
  useIsActive,
  useItems,
  useOptions,
  usePracticalFilterCount,
  useSortCriteria,
} from '../../state/selectors'
import BasePage from './BasePage'
import { useAppDispatch, useAppSelector } from '../../store'
import { setUi, replaceActive, toggleSelected } from '../../state/ui'
import { sortItems } from '../../utils/customSort'
import { filterItems } from '../../utils/customFilter'

export interface Props<T extends Item> {
  itemType: T['type'],
}

function ItemPage<T extends Item>({
  itemType,
}: Props<T>) {
  const dispatch = useAppDispatch()
  const isActive = useIsActive()
  const rawItems = useItems<T>(itemType)
  const selected = useAppSelector(state => state.ui.selected)
  const filters = useAppSelector(state => state.ui.filters)
  const defaultFrequencies = useAppSelector(state => state.account.metadata?.defaultPrayerFrequency)
  const filterCount = usePracticalFilterCount()
  const [sortCriteria] = useSortCriteria()
  const { bulkActionsOnMobile } = useOptions()

  const [showArchived, setShowArchived] = useState(false)
  const handleClickShowArchived = useCallback(
    () => setShowArchived(sa => !sa),
    [],
  )

  const applicableItems = useMemo(
    () => showArchived ? rawItems : rawItems.filter(item => !item.archived),
    [rawItems, showArchived],
  )
  const archivedCount = useMemo(
    () => rawItems.filter(item => item.archived).length,
    [rawItems],
  )

  const items = useMemo(
    () => {
      const filtered = filterItems(applicableItems, filters)
      const sorted = sortItems(filtered, sortCriteria)
      return sorted
    },
    [filters, applicableItems, sortCriteria],
  )

  const hiddenItemCount = applicableItems.length - items.length

  const handleClickItem = useCallback(
    (item: T) => {
      dispatch(replaceActive({ item: item.id }))
    },
    [dispatch],
  )
  const handleClickAdd = useCallback(
    () => {
      dispatch(replaceActive({
        newItem: {
          ...getBlankItem(itemType),
          prayerFrequency: defaultFrequencies?.[itemType] ?? 'none',
        },
      }))
    },
    [defaultFrequencies, dispatch, itemType],
  )
  const handleCheck = useCallback(
    (item: T) => dispatch(toggleSelected(item.id)),
    [dispatch],
  )
  const allSelected = useMemo(
    () => selected.length === items.length && selected.length > 0,
    [items.length, selected.length],
  )
  const handleSelectAll = useCallback(
    () => {
      const newSelected = allSelected ? [] : items.map(item => item.id)
      dispatch(setUi({ selected: newSelected }))
    },
    [allSelected, dispatch, items],
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

  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const checkboxes = !sm || bulkActionsOnMobile
  const pluralLabel = getItemTypeLabel(itemType, true)
  const pluralLabelLower = pluralLabel.toLowerCase()
  const maxTags = sm ? 2 : 3

  const noItemsHint = (
    hiddenItemCount
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
                  item
                  xs={12}
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
      onSelectAll={checkboxes ? handleSelectAll : undefined}
      showFilter
      showSort
      topBar
      topBarTitle={itemCountText}
    >
      <ItemList
        checkboxes={checkboxes}
        disablePadding
        extraElements={extras}
        getChecked={getChecked}
        getDescription={getDescription}
        getHighlighted={getHighlighted}
        items={items}
        maxTags={maxTags}
        noItemsHint={noItemsHint}
        noItemsText={`No ${pluralLabelLower} found`}
        onCheck={handleCheck}
        onClick={handleClickItem}
      />
    </BasePage>
  )
}

export default ItemPage
