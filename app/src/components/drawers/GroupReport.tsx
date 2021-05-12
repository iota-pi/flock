import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Container,
  Divider,
  fade,
  Grid,
  Typography,
} from '@material-ui/core';
import {
  GroupItem,
  ItemNoteType,
} from '../../state/items';
import BaseDrawer, { ItemDrawerProps } from './BaseDrawer';


const useStyles = makeStyles(theme => ({
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  filler: {
    flexGrow: 1,
  },
  danger: {
    borderColor: theme.palette.error.light,
    color: theme.palette.error.light,

    '&:hover': {
      backgroundColor: fade(theme.palette.error.light, 0.08),
    },
  },
  emphasis: {
    fontWeight: 500,
  },
}));

export interface Props extends ItemDrawerProps {
  group: GroupItem,
}

const ALL_NOTE_TYPES = 'all';
export const noteFilterOptions: [ItemNoteType | typeof ALL_NOTE_TYPES, string][] = [
  [ALL_NOTE_TYPES, 'All Notes'],
  ['general', 'General Notes'],
  ['prayer', 'Prayer Points'],
  ['interaction', 'Interactions'],
];


function GroupReportDrawer({
  group,
  onClose,
  open,
  stacked,
}: Props) {
  const classes = useStyles();

  return (
    <>
      <BaseDrawer
        open={open}
        onClose={onClose}
        stacked={stacked}
      >
        <Container className={classes.drawerContainer}>
          <Typography variant="h3">
            {group.name}
          </Typography>

          {group.description && (
            <Typography paragraph>
              {group.description}
            </Typography>
          )}

          <div className={classes.filler} />

          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Divider />
            </Grid>

            <Grid item xs={12}>
              <Button
                color="primary"
                onClick={onClose}
                variant="contained"
                fullWidth
              >
                Done
              </Button>
            </Grid>
          </Grid>
        </Container>
      </BaseDrawer>
    </>
  );
}

export default GroupReportDrawer;
