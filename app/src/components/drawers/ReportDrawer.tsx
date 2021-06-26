import React, { useCallback, useState } from 'react';
import { Item } from '../../state/items';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import DrawerActions from './utils/DrawerActions';
import AnyItemDrawer from './AnyItemDrawer';

export interface Props extends ItemDrawerProps {
  canEdit?: boolean,
  item: Item,
}


function ReportDrawer({
  canEdit = false,
  item,
  onClose,
  open,
  stacked,
}: Props) {
  const [editing, setEditing] = useState(false);
  const handleEdit = useCallback(() => setEditing(true), []);
  const handleBack = useCallback(() => setEditing(false), []);
  const handleClose = useCallback(
    () => {
      setEditing(false);
      onClose();
    },
    [onClose],
  );

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={handleClose}
        stacked={stacked}
      >
        <ItemReport
          item={item}
          canEdit={canEdit}
          onEdit={handleEdit}
        />

        <DrawerActions
          onDone={handleClose}
        />
      </BaseDrawer>

      {canEdit && (
        <AnyItemDrawer
          item={item}
          onBack={handleBack}
          onClose={handleBack}
          stacked={stacked}
          open={editing}
        />
      )}
    </>
  );
}

export default ReportDrawer;
