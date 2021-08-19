import { Fragment, ReactNode, useCallback, useMemo } from 'react';
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
import { getItemById, getItemName, Item, ItemNote } from '../state/items';
import { useItems, useNoteMap } from '../state/selectors';
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
  onClick?: (note: T) => () => void,
  onClickAction?: (note: T) => () => void,
  paddingTop?: boolean,
  showIcons?: boolean,
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
  const items = useItems();
  const noteMap = useNoteMap();

  const notes = useMemo(
    () => {
      let filteredNotes = rawNotes;
      if (hideEmpty) {
        filteredNotes = rawNotes.filter(note => !!note.content.trim());
      }
      const notesWithItems: [T, Item | undefined][] = filteredNotes.map(
        note => [note, getItemById(items, noteMap[note.id])],
      );
      return notesWithItems;
    },
    [hideEmpty, items, noteMap, rawNotes],
  );

  const handleClickAction = useCallback(
    (note: T) => {
      if (onClickAction) {
        return onClickAction(note);
      } else if (onClick) {
        return onClick(note);
      }
      return undefined;
    },
    [onClick, onClickAction],
  );
  const getNotePrimaryText = useCallback(
    (note: ItemNote, item: Item | undefined) => {
      if (displayItemNames) {
        return getItemName(item);
      }

      const content = note.content || '(no details)';
      return note.sensitive ? '(sensitive)' : content;
    },
    [displayItemNames],
  );
  const getNoteSecondaryText = useCallback(
    (note: ItemNote) => {
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
    [displayItemNames, displayNoteDate],
  );
  const compactList = !displayNoteDate && !displayItemNames;

  return (
    <List
      className={`${className} ${classes.root}`}
      disablePadding={!paddingTop}
    >
      {dividers && notes.length === 0 && <Divider />}

      {notes.map(([note, item]) => (
        <Fragment key={note.id}>
          {dividers && <Divider />}

          <ListItem
            button
            disabled={!onClick}
            onClick={onClick ? onClick(note) : undefined}
            selected={getHighlighted ? getHighlighted(note) : false}
            classes={{
              disabled: classes.disabledOverride,
            }}
            className={!compactList ? classes.consistantMinHeight : ''}
            dense={compactList}
          >
            {item && showIcons && (
              <ListItemIcon>
                {getIcon(item.type)}
              </ListItemIcon>
            )}

            <ListItemText
              primary={getNotePrimaryText(note, item)}
              secondary={getNoteSecondaryText(note)}
              classes={{
                primary: note.content ? undefined : classes.faded,
              }}
            />

            {(onClick || onClickAction) && (
              <ListItemSecondaryAction>
                <IconButton
                  className={!onClickAction ? classes.noHover : undefined}
                  disableRipple={!onClickAction}
                  onClick={handleClickAction(note)}
                >
                  {actionIcon || <ChevronRight />}
                </IconButton>
              </ListItemSecondaryAction>
            )}
          </ListItem>
        </Fragment>
      ))}

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
