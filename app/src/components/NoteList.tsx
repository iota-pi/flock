import { Fragment, ReactNode, useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemSecondaryAction,
  ListItemText,
} from '@material-ui/core';
import ChevronRight from '@material-ui/icons/ChevronRight';
import Visibility from '@material-ui/icons/Visibility';
import VisibilityOff from '@material-ui/icons/VisibilityOff';
import { getItemName, Item, ItemNote } from '../state/items';
import { useItemMap, useNoteMap } from '../state/selectors';
import { formatDate } from '../utils';
import { getIcon } from './Icons';

const useStyles = makeStyles(() => ({
  root: {
    paddingBottom: 0,
  },
  consistantMinHeight: {
    minHeight: 72,
  },
  disabledOverride: {
    opacity: '1 !important',
  },
  faded: {
    opacity: 0.85,
  },
}));

export interface Props<T extends ItemNote> {
  actionIcon?: ReactNode,
  className?: string,
  displayItemNames?: boolean,
  displayNoteDate?: boolean,
  dividers?: boolean,
  getHighlighted?: (note: T) => boolean,
  hideEmpty?: boolean,
  notes: T[],
  noNotesHint?: string,
  noNotesText?: string,
  onClick?: (note: T) => void,
  onClickAction?: (note: T) => void,
  paddingTop?: boolean,
  showIcons?: boolean,
}

export interface NoteListItemProps<T extends ItemNote> {
  actionIcon: ReactNode | undefined,
  compact: boolean,
  displayItemNames?: boolean,
  displayNoteDate?: boolean,
  highlighted: boolean,
  note: T,
  onClick: (() => void) | undefined,
  onClickAction: (() => void) | undefined,
  showIcons: boolean,
}

function NoteListItem<T extends ItemNote = ItemNote>({
  actionIcon,
  compact,
  displayItemNames,
  displayNoteDate,
  highlighted = false,
  note,
  onClick,
  onClickAction,
  showIcons,
}: NoteListItemProps<T>) {
  const classes = useStyles();
  const itemMap = useItemMap();
  const noteMap = useNoteMap();

  const [showSensitive, setShowSensitive] = useState(false);

  const item: Item | undefined = itemMap[noteMap[note.id]];
  const primaryText = useMemo(
    () => {
      if (displayItemNames) {
        return getItemName(item);
      }

      const content = note.content || '(no details)';
      return note.sensitive && !showSensitive ? '(sensitive)' : content;
    },
    [displayItemNames, item, note, showSensitive],
  );
  const secondaryText = useMemo(
    () => {
      const textParts = [];

      if (displayNoteDate) {
        const timeString = formatDate(new Date(note.date));
        textParts.push(timeString);
      }

      if (displayItemNames) {
        const content = (
          note.sensitive && !showSensitive
            ? '(sensitive)'
            : (note.content || '(no details)')
        );
        textParts.push(content);
      }

      return textParts.join('—');
    },
    [displayItemNames, displayNoteDate, note, showSensitive],
  );
  const icon = showIcons && item ? getIcon(item.type) : null;

  const handleToggleSensitive = useCallback(() => setShowSensitive(s => !s), []);

  return (
    <ListItem
      button
      disabled={!onClick}
      onClick={onClick}
      selected={highlighted}
      classes={{
        disabled: classes.disabledOverride,
      }}
      className={!compact ? classes.consistantMinHeight : ''}
      dense={compact}
    >
      {icon && (
        <ListItemIcon>
          {icon}
        </ListItemIcon>
      )}

      <ListItemText
        primary={primaryText}
        secondary={secondaryText}
        classes={{
          primary: note.content ? undefined : classes.faded,
        }}
      />

      {note.sensitive && (
        <ListItemSecondaryAction>
          <IconButton onClick={handleToggleSensitive} size="large">
            {showSensitive ? <VisibilityOff /> : <Visibility />}
          </IconButton>
        </ListItemSecondaryAction>
      )}

      {onClickAction && (
        <ListItemSecondaryAction>
          <IconButton onClick={onClickAction} size="large">
            {actionIcon || <ChevronRight />}
          </IconButton>
        </ListItemSecondaryAction>
      )}
    </ListItem>
  );
}


function NoteList<T extends ItemNote = ItemNote>({
  actionIcon,
  className,
  displayItemNames = true,
  displayNoteDate = true,
  dividers,
  getHighlighted,
  hideEmpty = false,
  paddingTop = true,
  notes: rawNotes,
  noNotesHint,
  noNotesText,
  onClick,
  onClickAction,
  showIcons = false,
}: Props<T>) {
  const classes = useStyles();

  const compactList = !displayNoteDate && !displayItemNames;

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
  const noteList = useMemo(
    () => notes.map(note => (
      <Fragment key={note.id}>
        {dividers && <Divider />}

        <NoteListItem
          actionIcon={actionIcon}
          compact={compactList}
          displayItemNames={displayItemNames}
          displayNoteDate={displayNoteDate}
          highlighted={getHighlighted ? getHighlighted(note) : false}
          note={note}
          onClick={onClick && (() => onClick(note))}
          onClickAction={onClickAction && (() => onClickAction(note))}
          showIcons={showIcons}
        />
      </Fragment>
    )),
    [
      actionIcon,
      compactList,
      dividers,
      displayItemNames,
      displayNoteDate,
      getHighlighted,
      notes,
      onClick,
      onClickAction,
      showIcons,
    ],
  );


  return (
    <List
      className={`${className} ${classes.root}`}
      disablePadding={!paddingTop}
    >
      {dividers && notes.length === 0 && <Divider />}

      {noteList}

      {notes.length === 0 && (
        <ListItem>
          <ListItemText primary={noNotesText} secondary={noNotesHint} />
        </ListItem>
      )}

      {dividers && <Divider />}
    </List>
  );
}

export default NoteList;
