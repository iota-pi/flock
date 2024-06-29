import { createSvgIcon, SvgIconTypeMap } from '@mui/material'
import type { OverridableComponent } from '@mui/material/OverridableComponent'

import AddIcon from '@mui/icons-material/Add'
import ArchiveIcon from '@mui/icons-material/Archive'
import BackIcon from '@mui/icons-material/ChevronLeft'
import CalendarIcon from '@mui/icons-material/Today'
import DeleteIcon from '@mui/icons-material/DeleteOutline'
import DownloadIcon from '@mui/icons-material/Download'
import EditIcon from '@mui/icons-material/Edit'
import FilterIcon from '@mui/icons-material/FilterAlt'
import FrequencyIcon from '@mui/icons-material/Schedule'
import GroupIcon from '@mui/icons-material/Groups'
import HomeIcon from '@mui/icons-material/Home'
import MenuIcon from '@mui/icons-material/Menu'
import MinusIcon from '@mui/icons-material/Remove'
import NextIcon from '@mui/icons-material/ChevronRight'
import NotesIcon from '@mui/icons-material/Notes'
import NotificationIcon from '@mui/icons-material/Notifications'
import OptionsIcon from '@mui/icons-material/Settings'
import PasswordIcon from '@mui/icons-material/Password'
import PersonIcon from '@mui/icons-material/Person'
import PrayerPointIcon from '@mui/icons-material/FormatListBulleted'
import RemoveIcon from '@mui/icons-material/Close'
import ReportIcon from '@mui/icons-material/Description'
import ResetIcon from '@mui/icons-material/Replay'
import SaveIcon from '@mui/icons-material/Check'
import SearchIcon from '@mui/icons-material/Search'
import ServerIcon from '@mui/icons-material/Dns'
import SignOutIcon from '@mui/icons-material/ExitToApp'
import SortIcon from '@mui/icons-material/Sort'
import SuggestIcon from '@mui/icons-material/Update'
import UnarchiveIcon from '@mui/icons-material/Unarchive'
import UploadIcon from '@mui/icons-material/Upload'
import WarningIcon from '@mui/icons-material/Warning'

import { FaPrayingHands } from 'react-icons/fa'

import { Item } from '../state/items'

const PrayerIcon = createSvgIcon(<FaPrayingHands />, 'PrayerIcon')

export type MuiIconType = OverridableComponent<SvgIconTypeMap<object, 'svg'>>

export {
  AddIcon,
  ArchiveIcon,
  BackIcon,
  BackIcon as ContractMenuIcon,
  CalendarIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  FilterIcon,
  FrequencyIcon,
  GroupIcon,
  HomeIcon,
  MenuIcon,
  MinusIcon,
  NextIcon,
  NextIcon as ExpandMenuIcon,
  NotesIcon,
  NotificationIcon,
  OptionsIcon,
  PasswordIcon,
  PersonIcon,
  PrayerIcon,
  PrayerPointIcon,
  RemoveIcon,
  ReportIcon,
  ResetIcon,
  SaveIcon,
  SearchIcon,
  ServerIcon,
  SignOutIcon,
  SortIcon,
  SuggestIcon,
  UnarchiveIcon,
  UploadIcon,
  WarningIcon,
}

export function getIconType(itemType: Item['type']): MuiIconType {
  const iconTypeMap: Record<typeof itemType, MuiIconType> = {
    person: PersonIcon,
    group: GroupIcon,
  }
  return iconTypeMap[itemType]
}

export function getIcon(itemType: Item['type']) {
  const IconType = getIconType(itemType)
  return <IconType />
}
