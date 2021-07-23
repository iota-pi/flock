import React, { useCallback } from 'react';
import { Item } from '../../state/items';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import { useAppDispatch } from '../../store';
import { pushActive } from '../../state/ui';

export interface Props extends BaseDrawerProps {
  canEdit?: boolean,
  item: Item,
  onDone?: () => void,
  onNext?: () => void,
  onSkip?: () => void,
}


function ReportDrawer({
  alwaysTemporary,
  canEdit = false,
  item,
  onClose,
  onDone,
  onNext,
  onSkip,
  open,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const handleEdit = useCallback(
    () => dispatch(pushActive({ item })),
    [dispatch, item],
  );

  const handleClose = useCallback(
    () => {
      onClose();
    },
    [onClose],
  );
  const handlePrayedFor = useCallback(
    () => {
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
      if (onSkip) {
        onSkip();
      } else {
        onClose();
      }
    },
    [onClose, onSkip],
  );

  return (
    <BaseDrawer
      ActionProps={onNext ? {
        onSkip: handleSkip,
        onNext: handlePrayedFor,
      } : {
        onSkip: handleSkip,
        onDone: handlePrayedFor,
      }}
      alwaysTemporary={alwaysTemporary}
      hideBackButton
      open={open}
      onClose={handleClose}
      stacked={stacked}
    >
      <ItemReport
        item={item}
        canEdit={canEdit}
        onEdit={handleEdit}
      />
    </BaseDrawer>
  );
}

export default ReportDrawer;
