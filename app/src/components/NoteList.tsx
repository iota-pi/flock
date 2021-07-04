import React, { ReactNode, useCallback } from 'react';
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
import { getItemById, getItemName, ItemNote, ItemNoteType } from '../state/items';
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
}));

export interface Props<T extends ItemNoteType> {
  actionIcon?: ReactNode,
  className?: string,
  dividers?: boolean,
  displayItemNames?: boolean,
  displayNoteDate?: boolean,
  paddingTop?: boolean,
  notes: ItemNote<T>[],
  noNotesHint?: string,
  noNotesText?: string,
  onClick?: (note: ItemNote<T>) => () => void,
  onClickAction?: (note: ItemNote<T>) => () => void,
}


function NoteList<T extends ItemNoteType = ItemNoteType>({
  actionIcon,
  className,
  displayItemNames = true,
  displayNoteDate = true,
  dividers,
  paddingTop = true,
  notes,
  noNotesHint,
  noNotesText,
  onClick,
  onClickAction,
}: Props<T>) {
  const classes = useStyles();
  const items = useItems();
  const noteMap = useNoteMap();

  const handleClickAction = useCallback(
    (note: ItemNote<T>) => {
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

      return note.sensitive ? '(sensitive)' : note.content;
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
        const content = note.sensitive ? '(sensitive)' : note.content;
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
