import { createSvgIcon, SvgIconTypeMap } from '@material-ui/core';
import { OverridableComponent } from '@material-ui/core/OverridableComponent';

import ActionIcon from '@material-ui/icons/ArrowForward';
import AddIcon from '@material-ui/icons/Add';
import ArchiveIcon from '@material-ui/icons/Archive';
import BackIcon from '@material-ui/icons/ChevronLeft';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import DownloadIcon from '@material-ui/icons/Download';
import EditIcon from '@material-ui/icons/Edit';
import FilterIcon from '@material-ui/icons/FilterAlt';
import FrequencyIcon from '@material-ui/icons/Schedule';
import GeneralIcon from '@material-ui/icons/MoreHoriz';
import GroupIcon from '@material-ui/icons/Groups';
import HomeIcon from '@material-ui/icons/Home';
import InteractionIcon from '@material-ui/icons/QuestionAnswer';
import MinusIcon from '@material-ui/icons/Remove';
import NextIcon from '@material-ui/icons/ChevronRight';
import OptionsIcon from '@material-ui/icons/Settings';
import PersonIcon from '@material-ui/icons/Person';
import PrayerPointIcon from '@material-ui/icons/FormatListBulleted';
import RemoveIcon from '@material-ui/icons/Close';
import ReportIcon from '@material-ui/icons/Description';
import ResetIcon from '@material-ui/icons/Replay';
import SaveIcon from '@material-ui/icons/Check';
import SearchIcon from '@material-ui/icons/Search';
import SignOutIcon from '@material-ui/icons/ExitToApp';
import SortIcon from '@material-ui/icons/Sort';
import SuggestIcon from '@material-ui/icons/Update';
import TagIcon from '@material-ui/icons/Label';
import UnarchiveIcon from '@material-ui/icons/Unarchive';
import UploadIcon from '@material-ui/icons/Upload';
import WarningIcon from '@material-ui/icons/Warning';

import { FaPrayingHands } from 'react-icons/fa';

import { ItemOrNoteType } from '../state/items';

const PrayerIcon = createSvgIcon(<FaPrayingHands />, 'PrayerIcon');

export type MuiIconType = OverridableComponent<SvgIconTypeMap<{}, 'svg'>>;

export {
  ActionIcon,
  AddIcon,
  ArchiveIcon,
  BackIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  FilterIcon,
  FrequencyIcon,
  GeneralIcon,
  GroupIcon,
  HomeIcon,
  InteractionIcon,
  MinusIcon,
  NextIcon,
  OptionsIcon,
  PersonIcon,
  PrayerIcon,
  PrayerPointIcon,
  RemoveIcon,
  ReportIcon,
  ResetIcon,
  SaveIcon,
  SearchIcon,
  SignOutIcon,
  SortIcon,
  SuggestIcon,
  TagIcon,
  UnarchiveIcon,
  UploadIcon,
  WarningIcon,
};

export function getIconType(itemType: ItemOrNoteType | 'tag'): MuiIconType {
  const iconTypeMap: Record<typeof itemType, MuiIconType> = {
    person: PersonIcon,
    group: GroupIcon,
    action: ActionIcon,
    interaction: InteractionIcon,
    prayer: PrayerIcon,
    general: GeneralIcon,
    tag: TagIcon,
  };
  return iconTypeMap[itemType];
}

export function getIcon(itemType: ItemOrNoteType | 'tag') {
  const IconType = getIconType(itemType);
  return <IconType />;
}
