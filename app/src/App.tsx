import React from 'react';
import { makeStyles } from '@material-ui/core/styles';
import { Container, Grid, Typography } from '@material-ui/core';


const useStyles = makeStyles(theme => ({
  header: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(4),
    backgroundColor: theme.palette.grey[100],
  },
  section: {
    paddingTop: theme.spacing(4),
    paddingBottom: theme.spacing(4),
  },
  paddingTop: {
    paddingTop: theme.spacing(2),
  },
}));

export default function App() {
  const classes = useStyles();

  return (
    <div>
      <Container maxWidth="md">
        <Grid container className={classes.paddingTop}>
          <Grid item xs={12} sm={6}>
            Hi
          </Grid>
          <Grid item xs={12} sm={6}>
            There
          </Grid>
        </Grid>
      </Container>

      <Container maxWidth="md" className={classes.section}>
        <Typography variant="h3" gutterBottom>
          Something
        </Typography>
      </Container>
    </div>
  );
}
