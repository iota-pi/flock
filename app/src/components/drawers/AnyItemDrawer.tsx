import React from 'react';
import { Item } from '../../state/items';
import { ItemDrawerProps } from './BaseDrawer';
import GeneralDrawer from './General';
import GroupDrawer from './Group';
import PersonDrawer from './Person';


export interface Props extends ItemDrawerProps {
  item: Item | undefined,
}

function AnyItemDrawer({ item, ...props }: Props) {
  if (item?.type === 'general') {
    return <GeneralDrawer item={item} {...props} />;
  } else if (item?.type === 'group') {
    return <GroupDrawer item={item} {...props} />;
  } else if (item?.type === 'person') {
    return <PersonDrawer item={item} {...props} />;
  }

  return null;
}

export default AnyItemDrawer;
