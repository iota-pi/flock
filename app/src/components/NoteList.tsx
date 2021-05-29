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
import { formatDateAndTime } from '../utils';

const useStyles = makeStyles(() => ({
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
  notes: ItemNote<T>[],
  noNotesHint?: string,
  noNotesText?: string,
  onClick?: (note: ItemNote<T>) => () => void,
  onClickAction?: (note: ItemNote<T>) => () => void,
}


function NoteList<T extends ItemNoteType = ItemNoteType>({
  actionIcon,
  className,
  dividers,
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
  const getNoteSubtext = useCallback(
    (note: ItemNote) => {
      const timeString = formatDateAndTime(new Date(note.date));
      const content = note.content;
      return `${timeString} — ${content}`;
    },
    [],
  );

  return (
    <List className={className}>
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
            className={classes.consistantMinHeight}
          >
            <ListItemText
              primary={getItemName(getItemById(items, noteMap[note.id]))}
              secondary={getNoteSubtext(note)}
            />
            <ListItemSecondaryAction>
              <IconButton
                className={!onClickAction ? classes.noHover : undefined}
                disableRipple={!onClickAction}
                onClick={handleClickAction(note)}
              >
                {actionIcon || <ChevronRight />}
              </IconButton>
            </ListItemSecondaryAction>
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
