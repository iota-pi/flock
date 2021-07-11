import React, { useCallback, useState } from 'react';
import { Item } from '../../state/items';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import DrawerActions from './utils/DrawerActions';
import AnyItemDrawer from './AnyItemDrawer';

export interface Props extends ItemDrawerProps {
  canEdit?: boolean,
  item: Item,
  onDone?: () => void,
  onNext?: () => void,
  onSkip?: () => void,
}


function ReportDrawer({
  canEdit = false,
  item,
  onClose,
  onDone,
  onNext,
  onSkip,
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
  const handlePrayedFor = useCallback(
    () => {
      setEditing(false);
      if (onNext) {
        onNext();
      } else {
        if (onDone) {
          onDone();
        }
        onClose();
      }
    },
    [onClose, onDone, onNext],
  );
  const handleSkip = useCallback(
    () => {
      setEditing(false);
      if (onSkip) {
        onSkip();
      } else {
        onClose();
      }
    },
    [onClose, onSkip],
  );

  return (
    <>
      <BaseDrawer
        ActionProps={onNext ? {
          onSkip: handleSkip,
          onNext: handlePrayedFor,
        } : {
          onSkip: handleSkip,
          onDone: handlePrayedFor,
        }}
        open={open}
        onClose={handleClose}
        stacked={stacked}
      >
        <ItemReport
          item={item}
          canEdit={canEdit}
          onEdit={handleEdit}
        />

        {onNext ? (
          <DrawerActions
            onSkip={handleSkip}
            onNext={handlePrayedFor}
          />
        ) : (
          <DrawerActions
            onSkip={handleSkip}
            onDone={handlePrayedFor}
          />
        )}
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
