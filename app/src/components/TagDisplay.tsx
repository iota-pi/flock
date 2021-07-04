import React from 'react';
import { Chip, makeStyles } from '@material-ui/core';

const useStyles = makeStyles(theme => ({
  tagChip: {
    marginRight: theme.spacing(1),
    marginTop: theme.spacing(0.5),
    marginBottom: theme.spacing(0.5),
  },
  chipLabel: {
    paddingLeft: theme.spacing(2),
    paddingRight: theme.spacing(2),
  },
}));

export interface Props {
  tags: string[],
}

function TagDisplay({
  tags,
}: Props) {
  const classes = useStyles();

  return (
    <>
      {tags.map(tag => (
        <Chip
          key={tag}
          label={tag}
          classes={{ label: classes.chipLabel }}
          className={classes.tagChip}
          variant="outlined"
        />
      ))}
    </>
  );
}

export default TagDisplay;
