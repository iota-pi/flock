import { useCallback, useMemo, useRef, useState } from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  Checkbox,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
  Theme,
  Typography,
  useMediaQuery,
} from '@material-ui/core';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { FilterIcon, MuiIconType, OptionsIcon, SortIcon } from '../Icons';
import { useOption } from '../../state/selectors';
import SortDialog from '../dialogs/SortDialog';
import FilterDialog from '../dialogs/FilterDialog';
import { useAppSelector } from '../../store';

const MENU_POPUP_ID = 'top-bar-menu';

const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    alignItems: 'center',
    padding: theme.spacing(2),
  },
  spacer: {
    flexGrow: 1,
  },
}));

export interface MenuItemData {
  icon: MuiIconType,
  key: string,
  label: string,
  onClick: () => void,
}

export interface Props {
  allSelected?: boolean,
  menuItems: MenuItemData[],
  onSelectAll?: () => void,
  sortable?: boolean,
  title?: string,
}


function TopBar({
  allSelected = false,
  menuItems,
  onSelectAll,
  sortable,
  title,
}: Props) {
  const classes = useStyles();

  const [bulkActions, setBulkActions] = useOption('bulkActionsOnMobile');
  const [showOptions, setShowOptions] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [showSort, setShowSort] = useState(false);

  const filterCount = useAppSelector(state => state.ui.filters.length);

  const optionsAnchor = useRef<HTMLButtonElement>(null);

  const smallScreen = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'));
  const alwaysShowCheckbox = !smallScreen;
  const showCheckbox = onSelectAll && (alwaysShowCheckbox || bulkActions);

  const handleClickOptions = useCallback(() => setShowOptions(o => !o), []);
  const handleCloseOptions = useCallback(() => setShowOptions(false), []);
  const handleClickFilter = useCallback(() => setShowFilter(f => !f), []);
  const handleCloseFilter = useCallback(() => setShowFilter(false), []);
  const handleToggleBulkActions = useCallback(
    () => {
      setBulkActions(b => !b);
      handleCloseOptions();
    },
    [handleCloseOptions, setBulkActions],
  );
  const handleClickSort = useCallback(
    () => {
      setShowSort(true);
      handleCloseOptions();
    },
    [handleCloseOptions],
  );
  const handleCloseSort = useCallback(() => setShowSort(false), []);

  const allMenuItems = useMemo(
    () => {
      const result = [...menuItems];
      if (sortable) {
        result.push({
          icon: SortIcon,
          key: 'customise-sort',
          label: 'Custom Sort',
          onClick: handleClickSort,
        });
      }
      if (!alwaysShowCheckbox) {
        result.push({
          icon: bulkActions ? VisibilityOff : Visibility,
          key: 'bulk-actions',
          label: `${bulkActions ? 'Hide' : 'Show'} checkboxes`,
          onClick: handleToggleBulkActions,
        });
      }
      return result;
    },
    [
      alwaysShowCheckbox,
      bulkActions,
      handleClickSort,
      handleToggleBulkActions,
      menuItems,
      sortable,
    ],
  );

  return (
    <Paper className={classes.root}>
      {showCheckbox && (
        <div>
          <Checkbox
            checked={allSelected}
            onClick={onSelectAll}
          />
        </div>
      )}

      {title && (
        <div>
          <Typography color="text.secondary">
            {title}
          </Typography>
        </div>
      )}

      <div className={classes.spacer} />

      <IconButton
        color={filterCount > 0 ? 'warning' : undefined}
        onClick={handleClickFilter}
        size="large"
      >
        <FilterIcon />
      </IconButton>

      {allMenuItems.length > 0 && (
        <IconButton
          aria-controls={MENU_POPUP_ID}
          aria-haspopup="true"
          onClick={handleClickOptions}
          ref={optionsAnchor}
          size="large"
        >
          <OptionsIcon />
        </IconButton>
      )}

      <Menu
        anchorEl={optionsAnchor.current}
        id={MENU_POPUP_ID}
        open={showOptions}
        onClose={handleCloseOptions}
      >
        {allMenuItems.map(menuItem => (
          <MenuItem
            key={menuItem.key}
            onClick={menuItem.onClick}
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
    </Paper>
  );
}

export default TopBar;
