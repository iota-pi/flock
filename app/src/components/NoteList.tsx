import { Fragment, ReactNode, useMemo } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
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
import { getItemName, Item, ItemNote } from '../state/items';
import { useItemMap, useNoteMap } from '../state/selectors';
import { formatDate } from '../utils';
import { getIcon } from './Icons';

const useStyles = makeStyles(() => ({
  root: {
    paddingBottom: 0,
  },
  noHover: {
    '&:hover': {
      backgroundColor: 'transparent',
    },
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
  actionIcon?: ReactNode,
  compact: boolean,
  displayItemNames?: boolean,
  displayNoteDate?: boolean,
  highlighted: boolean,
  icon: ReactNode | undefined,
  item: Item | undefined,
  note: T,
  onClick: (() => void) | undefined,
  onClickAction: (() => void) | undefined,
}

function NoteListItem<T extends ItemNote = ItemNote>({
  actionIcon,
  compact,
  displayItemNames,
  displayNoteDate,
  highlighted = false,
  icon,
  item,
  note,
  onClick,
  onClickAction,
}: NoteListItemProps<T>) {
  const classes = useStyles();
  const primaryText = useMemo(
    () => {
      if (displayItemNames) {
        return getItemName(item);
      }

      const content = note.content || '(no details)';
      return note.sensitive ? '(sensitive)' : content;
    },
    [displayItemNames, item, note],
  );
  const secondaryText = useMemo(
    () => {
      const textParts = [];

      if (displayNoteDate) {
        const timeString = formatDate(new Date(note.date));
        textParts.push(timeString);
      }

      if (displayItemNames) {
        const content = note.sensitive ? '(sensitive)' : (note.content || '(no details)');
        textParts.push(content);
      }

      return textParts.join('—');
    },
    [displayItemNames, displayNoteDate, note],
  );
  const handleClickAction = onClickAction || onClick;

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

      {handleClickAction && (
        <ListItemSecondaryAction>
          <IconButton
            className={!onClickAction ? classes.noHover : undefined}
            disableRipple={!onClickAction}
            onClick={handleClickAction}
          >
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
  const itemMap = useItemMap();
  const noteMap = useNoteMap();

  const compactList = !displayNoteDate && !displayItemNames;

  const notes = useMemo(
    () => {
      let filteredNotes = rawNotes;
      if (hideEmpty) {
        filteredNotes = rawNotes.filter(note => !!note.content.trim());
      }
      const notesWithItems: [T, Item | undefined][] = filteredNotes.map(
        note => [note, itemMap[noteMap[note.id]]],
      );
      return notesWithItems;
    },
    [hideEmpty, itemMap, noteMap, rawNotes],
  );
  const noteList = useMemo(
    () => notes.map(([note, item]) => (
      <Fragment key={note.id}>
        {dividers && <Divider />}

        <NoteListItem
          actionIcon={actionIcon}
          compact={compactList}
          displayItemNames={displayItemNames}
          displayNoteDate={displayNoteDate}
          highlighted={getHighlighted ? getHighlighted(note) : false}
          icon={showIcons && item ? getIcon(item.type) : null}
          item={item}
          note={note}
          onClick={onClick && (() => onClick(note))}
          onClickAction={onClickAction && (() => onClickAction(note))}
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
