import { lazy, Suspense, useCallback, useState } from 'react'
import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { styled, Theme } from '@mui/material/styles'
import { FilterIcon, MuiIconType, OptionsIcon, SortIcon } from '../Icons'
import { usePracticalFilterCount } from 'src/state/selectors'
import SyncNowButton from './SyncNowButton'
import { useDialogState } from 'src/hooks/useDialogState'


const SortDialog = lazy(() => import('../dialogs/SortDialog'))
const FilterDialog = lazy(() => import('../dialogs/FilterDialog'))

const MENU_POPUP_ID = 'top-bar-menu'

const StyledPaper = styled(Paper)(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  padding: theme.spacing(2),
  gap: theme.spacing(0.5),

  [theme.breakpoints.down('md')]: {
    padding: theme.spacing(1),
  },
}))
const TitleHolder = styled('div')(({ theme }) => ({
  paddingLeft: theme.spacing(1),
}))

export interface MenuItemData {
  closeOnClick?: boolean,
  icon: MuiIconType,
  key: string,
  label: string,
  onClick: () => void,
}

interface Props {
  allSelected: boolean,
  filterable?: boolean,
  menuItems: MenuItemData[],
  onSelectAll?: () => void,
  sortable?: boolean,
  title?: string,
}


function TopBar({
  allSelected,
  filterable,
  menuItems,
  onSelectAll,
  sortable,
  title,
}: Props) {
  const [showOptions, setShowOptions] = useState(false)
  const {
    isOpen: isFilterOpen,
    toggleDialog: toggleFilterDialog,
    closeDialog: closeFilterDialog,
  } = useDialogState('filter')
  const {
    isOpen: isSortOpen,
    openDialog: openSortDialog,
    closeDialog: closeSortDialog,
  } = useDialogState('sort')

  const filterCount = usePracticalFilterCount()

  const [optionsAnchor, setOptionsAnchor] = useState<HTMLButtonElement | null>(null)

  const smallScreen = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const alwaysShowCheckbox = !smallScreen
  const showCheckbox = onSelectAll && (alwaysShowCheckbox)

  const handleClickOptions = useCallback(() => setShowOptions(o => !o), [])
  const handleCloseOptions = useCallback(() => setShowOptions(false), [])
  const handleClickFilter = useCallback(() => toggleFilterDialog(), [toggleFilterDialog])
  const handleCloseFilter = useCallback(() => closeFilterDialog(), [closeFilterDialog])
  const handleClickSort = useCallback(
    () => {
      openSortDialog()
      handleCloseOptions()
    },
    [handleCloseOptions, openSortDialog],
  )
  const handleCloseSort = useCallback(() => closeSortDialog(), [closeSortDialog])

  const handleClick = useCallback(
    (item: MenuItemData) => () => {
      item.onClick()
      if (item.closeOnClick) {
        handleCloseOptions()
      }
    },
    [handleCloseOptions],
  )

  return (
    <StyledPaper>
      {showCheckbox && (
        <div>
          <Checkbox
            checked={allSelected}
            onClick={onSelectAll}
            data-cy='select-all'
          />
        </div>
      )}
      {title && (
        <TitleHolder>
          <Typography sx={{
            color: "text.secondary"
          }}>
            {title}
          </Typography>
        </TitleHolder>
      )}
      <Box sx={{
        flexGrow: 1
      }} />
      {filterable && (
        <IconButton
          aria-label="Open filters"
          data-cy="open-filter"
          color={filterCount > 0 ? 'warning' : undefined}
          onClick={handleClickFilter}
          size="large"
        >
          <FilterIcon />
        </IconButton>
      )}
      {sortable && (
        <IconButton
          aria-label="Open sort options"
          data-cy="open-sort"
          onClick={handleClickSort}
          size="large"
        >
          <SortIcon />
        </IconButton>
      )}
      <SyncNowButton />
      {menuItems.length > 0 && (
        <IconButton
          aria-controls={MENU_POPUP_ID}
          aria-label="Open actions menu"
          aria-haspopup="true"
          onClick={handleClickOptions}
          ref={setOptionsAnchor}
          size="large"
        >
          <OptionsIcon />
        </IconButton>
      )}
      <Menu
        anchorEl={optionsAnchor}
        id={MENU_POPUP_ID}
        open={showOptions}
        onClose={handleCloseOptions}
      >
        {menuItems.map(menuItem => (
          <MenuItem
            key={menuItem.key}
            onClick={handleClick(menuItem)}
            data-cy={menuItem.key}
          >
            <ListItemIcon>
              <menuItem.icon />
            </ListItemIcon>

            {menuItem.label}
          </MenuItem>
        ))}
      </Menu>
      <Suspense fallback={null}>
        <FilterDialog
          onClose={handleCloseFilter}
          open={isFilterOpen}
        />

        <SortDialog
          onClose={handleCloseSort}
          open={isSortOpen}
        />
      </Suspense>
    </StyledPaper>
  )
}

export default TopBar
