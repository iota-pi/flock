import React from 'react';
import { Item } from '../../state/items';
import { ItemDrawerProps } from './BaseDrawer';
import EventDrawer from './Event';
import GroupDrawer from './Group';
import PersonDrawer from './Person';
import PlaceDrawer from './Place';


export interface Props extends ItemDrawerProps {
  item: Item | undefined,
}

function AnyItemDrawer({ item, ...props }: Props) {
  if (item?.type === 'event') {
    return <EventDrawer item={item} {...props} />;
  } else if (item?.type === 'group') {
    return <GroupDrawer item={item} {...props} />;
  } else if (item?.type === 'person') {
    return <PersonDrawer item={item} {...props} />;
  } else if (item?.type === 'place') {
    return <PlaceDrawer item={item} {...props} />;
  }

  return null;
}

export default AnyItemDrawer;
