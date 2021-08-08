import React, { useCallback } from 'react';
import { useHistory } from 'react-router-dom';
import { Chip, makeStyles } from '@material-ui/core';
import { getTagPage } from './pages';

const useStyles = makeStyles(theme => ({
  root: {
    display: 'flex',
    alignItems: 'center',
  },
  tagChip: {
    marginRight: theme.spacing(1),
    marginTop: theme.spacing(0.5),
    marginBottom: theme.spacing(0.5),

    '&:last-child': {
      marginRight: 0,
    },
  },
  chipLabel: {
    paddingLeft: theme.spacing(2),
    paddingRight: theme.spacing(2),
  },
  more: {
    marginLeft: theme.spacing(0.5),
    color: theme.palette.text.secondary,
  },
}));

export interface Props {
  tags: string[],
  linked?: boolean,
  max?: number,
}

function TagDisplay({
  tags,
  linked = false,
  max,
}: Props) {
  const classes = useStyles();
  const history = useHistory();

  const handleClick = useCallback(
    (tag: string) => (event: React.MouseEvent) => {
      history.push(getTagPage(tag));
      event.stopPropagation();
    },
    [history],
  );

  const limitedTags = max && tags.length > max ? tags.slice(0, max - 1) : tags;

  return (
    <div className={classes.root}>
      {limitedTags.map(tag => (
        <Chip
          key={tag}
          label={tag}
          classes={{ label: classes.chipLabel }}
          className={classes.tagChip}
          variant="outlined"
          onClick={linked ? handleClick(tag) : undefined}
        />
      ))}

      {limitedTags.length < tags.length && (
        <span className={classes.more}>
          {limitedTags.length > 0 ? (
            `+${tags.length - limitedTags.length} more`
          ) : (
            `${tags.length} tags`
          )}
        </span>
      )}
    </div>
  );
}

export default TagDisplay;
