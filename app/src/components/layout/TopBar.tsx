import { useCallback, useMemo, useRef, useState } from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import { Checkbox, IconButton, ListItemIcon, Menu, MenuItem, Paper, Theme, useMediaQuery } from '@material-ui/core';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { MuiIconType, OptionsIcon, SortIcon } from '../Icons';
import { useOption } from '../../state/selectors';
import SortDialog from '../dialogs/SortDialog';

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
}


function TopBar({
  allSelected = false,
  menuItems,
  onSelectAll,
  sortable,
}: Props) {
  const classes = useStyles();

  const [bulkActions, setBulkActions] = useOption('bulkActionsOnMobile');
  const [showOptions, setShowOptions] = useState(false);
  const [showSort, setShowSort] = useState(false);

  const optionsAnchor = useRef<HTMLButtonElement>(null);

  const smallScreen = useMediaQuery((theme: Theme) => theme.breakpoints.down('md'));
  const alwaysShowCheckbox = !smallScreen;
  const showCheckbox = onSelectAll && (alwaysShowCheckbox || bulkActions);

  const handleClickOptions = useCallback(() => setShowOptions(o => !o), []);
  const handleCloseOptions = useCallback(() => setShowOptions(false), []);
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

      <div className={classes.spacer} />

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

      <SortDialog
        onClose={handleCloseSort}
        open={showSort}
      />
    </Paper>
  );
}

export default TopBar;
