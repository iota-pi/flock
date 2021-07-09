import React from 'react';
import AddIcon from '@material-ui/icons/Add';
import BackIcon from '@material-ui/icons/ChevronLeft';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import EditIcon from '@material-ui/icons/Edit';
import GeneralIcon from '@material-ui/icons/Event';
import GroupsIcon from '@material-ui/icons/GroupWork';
import InteractionIcon from '@material-ui/icons/QuestionAnswer';
import NextIcon from '@material-ui/icons/ChevronRight';
import PersonIcon from '@material-ui/icons/Person';
import PrayerIcon from '@material-ui/icons/PhoneInTalk';
import RemoveIcon from '@material-ui/icons/Close';
import ReportIcon from '@material-ui/icons/Description';
import SaveIcon from '@material-ui/icons/Check';
import SearchIcon from '@material-ui/icons/Search';
import SuggestIcon from '@material-ui/icons/Update';
import TagIcon from '@material-ui/icons/Label';
import WarningIcon from '@material-ui/icons/Warning';
import { ItemType } from '../state/items';

export {
  AddIcon,
  BackIcon,
  DeleteIcon,
  EditIcon,
  GeneralIcon,
  GroupsIcon,
  InteractionIcon,
  NextIcon,
  PersonIcon,
  PrayerIcon,
  RemoveIcon,
  ReportIcon,
  SaveIcon,
  SearchIcon,
  SuggestIcon,
  TagIcon,
  WarningIcon,
};

export function getIcon(itemType: ItemType | 'tag') {
  if (itemType === 'person') {
    return <PersonIcon />;
  } else if (itemType === 'group') {
    return <GroupsIcon />;
  } else if (itemType === 'tag') {
    return <TagIcon />;
  }
  return <GeneralIcon />;
}
