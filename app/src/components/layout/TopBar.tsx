import { useCallback, useRef, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Checkbox, IconButton, ListItemIcon, Menu, MenuItem, Paper, Theme, useMediaQuery } from '@material-ui/core';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { MuiIconType, OptionsIcon } from '../Icons';
import { useOption } from '../../state/selectors';

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
}


function TopBar({
  allSelected = false,
  menuItems,
  onSelectAll,
}: Props) {
  const classes = useStyles();

  const [bulkActions, setBulkActions] = useOption('bulkActionsOnMobile');
  const [showOptions, setShowOptions] = useState(false);

  const optionsAnchor = useRef<HTMLButtonElement>(null);

  const smallScreen = useMediaQuery((theme: Theme) => theme.breakpoints.down('sm'));
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

  const allMenuItems = [...menuItems];
  if (!alwaysShowCheckbox) {
    allMenuItems.push({
      icon: bulkActions ? VisibilityOff : Visibility,
      key: 'bulk-actions',
      label: `${bulkActions ? 'Hide' : 'Show'} checkboxes`,
      onClick: handleToggleBulkActions,
    });
  }

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
    </Paper>
  );
}

export default TopBar;
