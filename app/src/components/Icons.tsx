import React from 'react';
import { createSvgIcon, SvgIconTypeMap } from '@material-ui/core';
import { OverridableComponent } from '@material-ui/core/OverridableComponent';

import AddIcon from '@material-ui/icons/Add';
import BackIcon from '@material-ui/icons/ChevronLeft';
import DeleteIcon from '@material-ui/icons/DeleteOutline';
import EditIcon from '@material-ui/icons/Edit';
import GeneralIcon from '@material-ui/icons/MoreHoriz';
import GroupsIcon from '@material-ui/icons/GroupWork';
import InteractionIcon from '@material-ui/icons/QuestionAnswer';
import NextIcon from '@material-ui/icons/ChevronRight';
import PersonIcon from '@material-ui/icons/People';
import PrayerPointIcon from '@material-ui/icons/FormatListBulleted';
import RemoveIcon from '@material-ui/icons/Close';
import ReportIcon from '@material-ui/icons/Description';
import SaveIcon from '@material-ui/icons/Check';
import SearchIcon from '@material-ui/icons/Search';
import SignOutIcon from '@material-ui/icons/ExitToApp';
import SuggestIcon from '@material-ui/icons/Update';
import TagIcon from '@material-ui/icons/Label';
import WarningIcon from '@material-ui/icons/Warning';

import { FaPrayingHands } from 'react-icons/fa';

import { ItemType } from '../state/items';

const PrayerIcon = createSvgIcon(<FaPrayingHands />, 'PrayerIcon');

export type MuiIconType = OverridableComponent<SvgIconTypeMap<{}, 'svg'>>;

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
  PrayerPointIcon,
  RemoveIcon,
  ReportIcon,
  SaveIcon,
  SearchIcon,
  SignOutIcon,
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
