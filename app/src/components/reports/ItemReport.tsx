import React from 'react';
import { Typography } from '@material-ui/core';
import { getItemName, Item } from '../../state/items';

export interface Props {
  item: Item,
}


function ItemReport({
  item,
}: Props) {
  return (
    <>
      <Typography variant="h3">
        {getItemName(item)}
      </Typography>

      {item.description && (
        <Typography paragraph>
          {item.description}
        </Typography>
      )}

      {'<insert maturity, attendance, and other fun things here />'}
    </>
  );
}

export default ItemReport;
