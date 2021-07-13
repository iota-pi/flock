import React, { useCallback, useState } from 'react';
import { Typography } from '@material-ui/core';
import { Item } from '../../state/items';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import AnyItemDrawer from './AnyItemDrawer';
import { MuiIconType } from '../Icons';
import LargeIcon from '../LargeIcon';

export interface Props extends ItemDrawerProps {
  canEdit?: boolean,
  item: Item,
  onDone?: () => void,
  onNext?: () => void,
  onSkip?: () => void,
  placeholderIcon: MuiIconType,
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
  placeholder,
  placeholderIcon,
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
        alwaysTemporary={alwaysTemporary}
        hideBackButton
        open={open}
        onClose={handleClose}
        stacked={stacked}
        placeholder={placeholder || (
          <>
            <LargeIcon icon={placeholderIcon} />

            <Typography variant="h5" color="textSecondary" align="center">
              Select an item from the list<br />
              to view more details
            </Typography>
          </>
        )}
      >
        <ItemReport
          item={item}
          canEdit={canEdit}
          onEdit={handleEdit}
        />
      </BaseDrawer>

      {canEdit && (
        <AnyItemDrawer
          alwaysTemporary
          item={item}
          onBack={handleBack}
          onClose={handleBack}
          open={editing}
          stacked={stacked}
        />
      )}
    </>
  );
}

export default ReportDrawer;
