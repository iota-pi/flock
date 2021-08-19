import { useCallback, useMemo } from 'react';
import { Item } from '../../state/items';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import { useAppDispatch } from '../../store';
import { pushActive, updateActive } from '../../state/ui';
import { useVault } from '../../state/selectors';
import { isSameDay } from '../../utils';
import { getLastPrayedFor } from '../../utils/prayer';

export interface Props extends BaseDrawerProps {
  canEdit?: boolean,
  item: Item,
  next?: Item[],
  praying?: boolean,
  onDone?: () => void,
  onSkip?: () => void,
}


function ReportDrawer({
  alwaysTemporary,
  canEdit: canEditRaw,
  item,
  next = [],
  onClose,
  onDone,
  onSkip,
  open,
  praying = false,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const handleEdit = useCallback(
    () => dispatch(pushActive({ item })),
    [dispatch, item],
  );
  const vault = useVault();

  const canEdit = canEditRaw !== undefined ? canEditRaw : praying;

  const prayedForToday = useMemo(
    () => isSameDay(new Date(), new Date(getLastPrayedFor(item))),
    [item],
  );
  const recordPrayer = useCallback(
    () => {
      if (!prayedForToday) {
        const prayedFor = [...item.prayedFor, new Date().getTime()];
        const newItem: Item = { ...item, prayedFor };
        vault?.store(newItem);
      }
    },
    [item, prayedForToday, vault],
  );

  const handleDone = useCallback(
    () => {
      if (onDone) {
        onDone();
      }
      if (praying) {
        recordPrayer();
      }
      if (next.length) {
        dispatch(updateActive({ item: next[0], next: next.slice(1) }));
      } else {
        onClose();
      }
    },
    [dispatch, next, onClose, onDone, praying, recordPrayer],
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
      ActionProps={next.length > 0 ? {
        onSkip: handleSkip,
        onNext: handleDone,
      } : {
        onSkip: handleSkip,
        onDone: handleDone,
      }}
      alwaysTemporary={alwaysTemporary}
      hideBackButton
      open={open}
      onClose={onClose}
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
