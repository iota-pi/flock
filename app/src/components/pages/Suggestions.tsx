import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, Grid, Typography } from '@material-ui/core';
import { useItems } from '../../state/selectors';
import ItemList from '../ItemList';
import { PersonItem } from '../../state/items';
import { getInteractionSuggestions, getLastInteractionDate } from '../../utils/interactions';
import PersonDrawer from '../drawers/Person';
import { formatDate } from '../../utils';

const useStyles = makeStyles(theme => ({
  root: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
  },
  heading: {
    fontWeight: 300,
  },
  flexRightLarge: {
    display: 'flex',
    alignItems: 'center',

    [theme.breakpoints.up('md')]: {
      justifyContent: 'flex-end',
    },
  },
}));


function SuggestionsPage() {
  const classes = useStyles();
  const people = useItems<PersonItem>('person');

  const [currentItem, setCurrentItem] = useState<PersonItem>(people[0]);
  const [showDrawer, setShowDrawer] = useState(false);

  const suggestions = useMemo(() => getInteractionSuggestions(people), [people]);

  const handleClick = useCallback(
    (item: PersonItem) => () => {
      setCurrentItem(item);
      setShowDrawer(true);
    },
    [],
  );
  const handleClose = useCallback(() => setShowDrawer(false), []);
  const getDescription = useCallback(
    (item: PersonItem) => {
      const interactionDate = getLastInteractionDate(item);
      if (interactionDate) {
        return `Last interaction: ${formatDate(new Date(interactionDate))}`;
      }
      return '';
    },
    [],
  );

  return (
    <Container maxWidth="xl" className={classes.root}>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Typography variant="h4" className={classes.heading}>
            Interaction Suggestions
          </Typography>
        </Grid>

        <Grid item xs={12}>
          <ItemList
            getDescription={getDescription}
            items={suggestions}
            onClick={handleClick}
            noItemsText="No interaction suggestions"
          />
        </Grid>
      </Grid>

      <PersonDrawer
        item={currentItem}
        open={showDrawer}
        onClose={handleClose}
        initialNotesType="interaction"
      />
    </Container>
  );
}

export default SuggestionsPage;
