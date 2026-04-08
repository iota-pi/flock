import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
import { useNavigationStore } from '../../state/navigationStore'
import { processItemsWithWorker } from '../../workers/itemWorkerManager'
import { useStableDeepValue } from '../../hooks/useStableDeepValue'

export interface Props<T extends Item> {
  itemType: T['type'],
}

function ItemPage<T extends Item>({
  itemType,
}: Props<T>) {
  const replaceActive = useNavigationStore(state => state.replaceActive)
  const setSelected = useNavigationStore(state => state.setSelected)
  const toggleSelected = useNavigationStore(state => state.toggleSelected)
  const isActive = useIsActive()
  const itemsInitialLoading = useItemsInitialLoading()
  const rawItems = useItems<T>(itemType)
  const selected = useNavigationStore(state => state.selected)
  const filters = useUiStore(state => state.filters)
  const [defaultFrequencies] = useMetadata('defaultPrayerFrequency', {})
  const filterCount = usePracticalFilterCount()
  const [sortCriteria] = useSortCriteria()

  const [showArchived, setShowArchived] = useState(false)
  const [items, setItems] = useState<T[]>(() => (
    showArchived ? rawItems : rawItems.filter(i => !i.archived) as T[]
  ))
  const [totalApplicable, setTotalApplicable] = useState(() => (
    showArchived ? rawItems.length : rawItems.filter(i => !i.archived).length
  ))
  const [archivedCount, setArchivedCount] = useState(() => (
    rawItems.filter(i => i.archived).length
  ))
  const stableFilters = useStableDeepValue(filters)
  const stableSortCriteria = useStableDeepValue(sortCriteria)

  useEffect(() => {
    let cancelled = false

    void processItemsWithWorker({
      items: rawItems,
      filters: stableFilters,
      sortCriteria: stableSortCriteria,
      showArchived,
    })
      .then(result => {
        if (cancelled) {
          return
        }

        setItems(result.results as T[])
        setTotalApplicable(result.totalApplicable)
        setArchivedCount(result.archivedCount)
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        const fallbackItems = showArchived ? rawItems : rawItems.filter(i => !i.archived)
        setItems(fallbackItems as T[])
        setTotalApplicable(fallbackItems.length)
        setArchivedCount(rawItems.filter(i => i.archived).length)
      })

    return () => {
      cancelled = true
    }
  }, [rawItems, showArchived, stableFilters, stableSortCriteria])

  const handleClickShowArchived = useCallback(
    () => setShowArchived(sa => !sa),
    [],
  )

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
      setSelected(newSelected)
    },
    [allSelected, items, setSelected],
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
