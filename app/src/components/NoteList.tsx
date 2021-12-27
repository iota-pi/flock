import { useCallback, useMemo, useState } from 'react';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { getItemName, ItemNote } from '../state/items';
import { useItemMap, useNoteMap } from '../state/selectors';
import { formatDate } from '../utils';
import { getIcon as getItemIcon } from './Icons';
import ItemList, { ItemListExtraElement } from './ItemList';

export interface Props<T extends ItemNote> {
  className?: string,
  displayItemNames?: boolean,
  displayNoteDate?: boolean,
  dividers?: boolean,
  getHighlighted?: (note: T) => boolean,
  extraElements?: ItemListExtraElement[],
  hideEmpty?: boolean,
  notes: T[],
  noNotesHint?: string,
  noNotesText?: string,
  onClick?: (note: T) => void,
  paddingTop?: boolean,
  showIcons?: boolean,
  viewHeight?: number,
}

function NoteList<T extends ItemNote = ItemNote>({
  className,
  displayItemNames = true,
  displayNoteDate = true,
  dividers,
  extraElements,
  getHighlighted,
  hideEmpty = false,
  paddingTop = true,
  notes: rawNotes,
  noNotesHint,
  noNotesText,
  onClick,
  showIcons = false,
  viewHeight,
}: Props<T>) {
  const compactList = !displayNoteDate && !displayItemNames;
  const [showSensitives, setShowSensitives] = useState<string[]>([]);
  const itemMap = useItemMap();
  const noteMap = useNoteMap();

  const notes = useMemo(
    () => {
      let filteredNotes = rawNotes;
      if (hideEmpty) {
        filteredNotes = rawNotes.filter(note => !!note.content.trim());
      }
      return filteredNotes;
    },
    [hideEmpty, rawNotes],
  );

  const getActionIcon = useCallback(
    (note: ItemNote) => {
      if (note.sensitive) {
        return showSensitives.includes(note.id) ? <VisibilityOff /> : <Visibility />;
      }
      return null;
    },
    [showSensitives],
  );
  const getIcon = useCallback(
    (note: ItemNote) => getItemIcon(itemMap[noteMap[note.id]].type),
    [itemMap, noteMap],
  );
  const getTitle = useCallback(
    (note: ItemNote) => {
      if (displayItemNames) {
        return getItemName(itemMap[noteMap[note.id]]);
      }

      const content = note.content || '(no details)';
      const showSensitive = showSensitives.includes(note.id);
      return note.sensitive && !showSensitive ? '(sensitive)' : content;
    },
    [displayItemNames, itemMap, noteMap, showSensitives],
  );
  const getDescription = useCallback(
    (note: ItemNote) => {
      const textParts = [];

      if (displayNoteDate) {
        const timeString = formatDate(new Date(note.date));
        textParts.push(timeString);
      }

      if (displayItemNames) {
        const showSensitive = showSensitives.includes(note.id);
        const content = (
          note.sensitive && !showSensitive
            ? '(sensitive)'
            : (note.content || '(no details)')
        );
        textParts.push(content);
      }

      return textParts.join('—');
    },
    [displayNoteDate, displayItemNames, showSensitives],
  );
  const handleToggleSensitive = useCallback(
    (note: ItemNote) => setShowSensitives(s => {
      const index = s.indexOf(note.id);
      if (index > -1) {
        return [...s.slice(0, index), ...s.slice(index + 1)];
      }
      return [...s, note.id];
    }),
    [],
  );


  return (
    <ItemList
      items={notes}
      compact={compactList}
      className={className}
      disablePadding={!paddingTop}
      dividers={dividers}
      extraElements={extraElements}
      getActionIcon={getActionIcon}
      getDescription={getDescription}
      getHighlighted={getHighlighted}
      getIcon={showIcons ? getIcon : undefined}
      getTitle={getTitle}
      noItemsText={noNotesText}
      noItemsHint={noNotesHint}
      onClick={onClick}
      onClickAction={handleToggleSensitive}
      showIcons={showIcons}
      viewHeight={viewHeight}
    />
  );
}

export default NoteList;
