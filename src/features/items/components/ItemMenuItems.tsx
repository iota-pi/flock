import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import MenuItem, { type MenuItemProps } from '@mui/material/MenuItem'

import type { Item } from 'src/state/items'
import { ArchiveIcon, PrayerIcon, UnarchiveIcon } from 'src/components/Icons'
import { isPrayedForToday, togglePrayedForToday } from 'src/utils/prayer'


interface ItemMenuItemProps extends Omit<MenuItemProps, 'onChange' | 'onClick'> {
  item: Item,
  onChange: (data: Partial<Item> | ((prev: Item) => Item)) => void,
}

export function MarkPrayedMenuItem({ item, onChange, ...props }: ItemMenuItemProps) {
  const prayedToday = isPrayedForToday(item)

  return (
    <MenuItem
      data-cy="mark-prayed"
      disabled={item.isNew}
      {...props}
      onClick={() => onChange(prev => ({ ...prev, prayedFor: togglePrayedForToday(prev) }))}
    >
      <ListItemIcon>
        <PrayerIcon />
      </ListItemIcon>
      <ListItemText>
        {prayedToday ? 'Unmark Prayed' : 'Mark as Prayed Today'}
      </ListItemText>
    </MenuItem>
  )
}

export function ArchiveMenuItem({ item, onChange, ...props }: ItemMenuItemProps) {
  return (
    <MenuItem
      data-cy="archive"
      disabled={item.isNew}
      {...props}
      onClick={() => onChange({ archived: !item.archived })}
    >
      <ListItemIcon>
        {item.archived ? <UnarchiveIcon /> : <ArchiveIcon />}
      </ListItemIcon>
      <ListItemText>{item.archived ? 'Unarchive' : 'Archive'}</ListItemText>
    </MenuItem>
  )
}
