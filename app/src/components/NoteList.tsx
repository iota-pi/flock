import React, { ReactNode, useCallback, useMemo } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemSecondaryAction,
  ListItemText,
} from '@material-ui/core';
import ChevronRight from '@material-ui/icons/ChevronRight';
import { getItemById, getItemName, ItemNote } from '../state/items';
import { useItems, useNoteMap } from '../state/selectors';
import { formatDate } from '../utils';

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
  dividers?: boolean,
  displayItemNames?: boolean,
  displayNoteDate?: boolean,
  hideEmpty?: boolean,
  paddingTop?: boolean,
  notes: T[],
  noNotesHint?: string,
  noNotesText?: string,
  onClick?: (note: T) => () => void,
  onClickAction?: (note: T) => () => void,
}


function NoteList<T extends ItemNote = ItemNote>({
  actionIcon,
  className,
  displayItemNames = true,
  displayNoteDate = true,
  dividers,
  hideEmpty = false,
  paddingTop = true,
  notes: rawNotes,
  noNotesHint,
  noNotesText,
  onClick,
  onClickAction,
}: Props<T>) {
  const classes = useStyles();
  const items = useItems();
  const noteMap = useNoteMap();

  const notes = useMemo(
    () => {
      if (hideEmpty) {
        return rawNotes.filter(note => !!note.content.trim());
      }
      return rawNotes;
    },
    [hideEmpty, rawNotes],
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
    (note: ItemNote) => {
      if (displayItemNames) {
        return getItemName(getItemById(items, noteMap[note.id]));
      }

      const content = note.content || '(no details)';
      return note.sensitive ? '(sensitive)' : content;
    },
    [displayItemNames, items, noteMap],
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

      {notes.map(note => (
        <React.Fragment key={note.id}>
          {dividers && <Divider />}

          <ListItem
            button
            disabled={!onClick}
            onClick={onClick ? onClick(note) : undefined}
            classes={{
              disabled: classes.disabledOverride,
            }}
            className={!compactList ? classes.consistantMinHeight : ''}
            dense={compactList}
          >
            <ListItemText
              primary={getNotePrimaryText(note)}
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
        </React.Fragment>
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
