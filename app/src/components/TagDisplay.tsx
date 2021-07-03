import React from 'react';
import { Chip, makeStyles } from '@material-ui/core';

const useStyles = makeStyles(theme => ({
  tagChip: {
    marginRight: theme.spacing(1),
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
          className={classes.tagChip}
          variant="outlined"
        />
      ))}
    </>
  );
}

export default TagDisplay;
