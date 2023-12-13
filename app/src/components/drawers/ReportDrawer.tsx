import { useCallback, useMemo } from 'react';
import { Item, ItemId } from '../../state/items';
import BaseDrawer, { BaseDrawerProps } from './BaseDrawer';
import ItemReport from '../reports/ItemReport';
import { useAppDispatch } from '../../store';
import { pushActive, updateActive } from '../../state/ui';
import { isSameDay } from '../../utils';
import { getLastPrayedFor } from '../../utils/prayer';
import { getIconType } from '../Icons';
import { storeItems } from '../../api/Vault';

export interface Props extends BaseDrawerProps {
  canEdit?: boolean,
  item: Item,
  next?: ItemId[],
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
  onExited,
  onSkip,
  open,
  praying = false,
  stacked,
}: Props) {
  const dispatch = useAppDispatch();
  const handleEdit = useCallback(
    () => dispatch(pushActive({ item: item.id })),
    [dispatch, item],
  );

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
        storeItems(newItem);
      }
    },
    [item, prayedForToday],
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
      }
      if (next.length) {
        dispatch(updateActive({ item: next[0], next: next.slice(1) }));
      } else {
        onClose();
      }
    },
    [dispatch, next, onClose, onSkip],
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
      itemKey={item.id}
      open={open}
      onBack={onClose}
      onClose={onClose}
      onExited={onExited}
      stacked={stacked}
      typeIcon={getIconType(item.type)}
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
