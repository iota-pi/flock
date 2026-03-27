import { useCallback, useState } from 'react'
import {
  Box,
  Checkbox,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
  styled,
  Theme,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { FilterIcon, MuiIconType, OptionsIcon, SortIcon } from '../Icons'
import { usePracticalFilterCount } from '../../state/selectors'
import SortDialog from '../dialogs/SortDialog'
import FilterDialog from '../dialogs/FilterDialog'
import SyncNowButton from './SyncNowButton'

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

export interface Props {
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
  const [showFilter, setShowFilter] = useState(false)
  const [showSort, setShowSort] = useState(false)

  const filterCount = usePracticalFilterCount()

  const [optionsAnchor, setOptionsAnchor] = useState<HTMLButtonElement | null>(null)

  const smallScreen = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const alwaysShowCheckbox = !smallScreen
  const showCheckbox = onSelectAll && (alwaysShowCheckbox)

  const handleClickOptions = useCallback(() => setShowOptions(o => !o), [])
  const handleCloseOptions = useCallback(() => setShowOptions(false), [])
  const handleClickFilter = useCallback(() => setShowFilter(f => !f), [])
  const handleCloseFilter = useCallback(() => setShowFilter(false), [])
  const handleClickSort = useCallback(
    () => {
      setShowSort(true)
      handleCloseOptions()
    },
    [handleCloseOptions],
  )
  const handleCloseSort = useCallback(() => setShowSort(false), [])

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
          <Typography color="text.secondary">
            {title}
          </Typography>
        </TitleHolder>
      )}

      <Box flexGrow={1} />

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

      <FilterDialog
        onClose={handleCloseFilter}
        open={showFilter}
      />

      <SortDialog
        onClose={handleCloseSort}
        open={showSort}
      />
    </StyledPaper>
  )
}

export default TopBar
