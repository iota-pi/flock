import { createSvgIcon, SvgIconTypeMap } from '@material-ui/core';
import { OverridableComponent } from '@material-ui/core/OverridableComponent';

import ActionIcon from '@material-ui/icons/ArrowForward';
import AddIcon from '@material-ui/icons/Add';
import ArchiveIcon from '@material-ui/icons/Archive';
import BackIcon from '@material-ui/icons/ChevronLeft';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import EditIcon from '@material-ui/icons/Edit';
import FrequencyIcon from '@material-ui/icons/Schedule';
import GeneralIcon from '@material-ui/icons/MoreHoriz';
import GroupIcon from '@material-ui/icons/GroupWork';
import InteractionIcon from '@material-ui/icons/QuestionAnswer';
import MinusIcon from '@material-ui/icons/Remove';
import NextIcon from '@material-ui/icons/ChevronRight';
import OptionsIcon from '@material-ui/icons/Settings';
import PersonIcon from '@material-ui/icons/People';
import PrayerPointIcon from '@material-ui/icons/FormatListBulleted';
import RemoveIcon from '@material-ui/icons/Close';
import ReportIcon from '@material-ui/icons/Description';
import ResetIcon from '@material-ui/icons/Replay';
import SaveIcon from '@material-ui/icons/Check';
import SearchIcon from '@material-ui/icons/Search';
import SignOutIcon from '@material-ui/icons/ExitToApp';
import SuggestIcon from '@material-ui/icons/Update';
import TagIcon from '@material-ui/icons/Label';
import UnarchiveIcon from '@material-ui/icons/Unarchive';
import WarningIcon from '@material-ui/icons/Warning';

import { FaPrayingHands } from 'react-icons/fa';

import { ItemType } from '../state/items';

const PrayerIcon = createSvgIcon(<FaPrayingHands />, 'PrayerIcon');

export type MuiIconType = OverridableComponent<SvgIconTypeMap<{}, 'svg'>>;

export {
  ActionIcon,
  AddIcon,
  ArchiveIcon,
  BackIcon,
  DeleteIcon,
  EditIcon,
  FrequencyIcon,
  GeneralIcon,
  GroupIcon,
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
  SuggestIcon,
  TagIcon,
  UnarchiveIcon,
  WarningIcon,
};

export function getIcon(itemType: ItemType | 'tag') {
  if (itemType === 'person') {
    return <PersonIcon />;
  } else if (itemType === 'group') {
    return <GroupIcon />;
  } else if (itemType === 'tag') {
    return <TagIcon />;
  }
  return <GeneralIcon />;
}
