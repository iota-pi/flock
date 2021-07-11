import React, { useCallback } from 'react';
import { useHistory } from 'react-router-dom';
import { Chip, makeStyles } from '@material-ui/core';
import { getTagPage } from './pages';

const useStyles = makeStyles(theme => ({
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
}));

export interface Props {
  tags: string[],
  linked?: boolean,
}

function TagDisplay({
  tags,
  linked = false,
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

  return (
    <div>
      {tags.map(tag => (
        <Chip
          key={tag}
          label={tag}
          classes={{ label: classes.chipLabel }}
          className={classes.tagChip}
          variant="outlined"
          onClick={linked ? handleClick(tag) : undefined}
        />
      ))}
    </div>
  );
}

export default TagDisplay;
