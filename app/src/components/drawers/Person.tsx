import React, {
  ChangeEvent,
  ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Button,
  Container,
  Drawer,
  Grid,
  TextField,
} from '@material-ui/core';
import { getBlankPerson, PersonItem, updateItems } from '../../state/items';
import { useAppDispatch, useVault } from '../../store';


const useStyles = makeStyles(theme => ({
  drawer: {
    flexShrink: 0,

    width: '60%',
    [theme.breakpoints.only('sm')]: {
      width: '70%',
    },
    [theme.breakpoints.only('xs')]: {
      width: '100%',
    },
  },
  drawerPaper: {
    width: '60%',
    [theme.breakpoints.only('sm')]: {
      width: '70%',
    },
    [theme.breakpoints.only('xs')]: {
      width: '100%',
    },
  },
  drawerContainer: {
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  fieldGroup: {
    paddingTop: theme.spacing(4),
  },
  standardInput: {
    marginRight: theme.spacing(4),
  },
  inheritColour: {
    color: 'inherit',
  },
}));

export interface Props {
  onClose: () => void,
  open: boolean,
  person: PersonItem | undefined,
}

export interface UserInterface {
  id: string,
  name: string,
  icon: ReactNode,
}


function PersonDrawer({
  onClose,
  open,
  person,
}: Props) {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const vault = useVault();

  const [localPerson, setLocalPerson] = useState(getBlankPerson());

  useEffect(
    () => {
      if (person) {
        setLocalPerson({ ...person });
      } else {
        setLocalPerson(getBlankPerson());
      }
    },
    [person],
  );

  const handleChange = useCallback(
    (key: keyof PersonItem) => (
      (event: ChangeEvent<HTMLInputElement>) => {
        const value = event.target.value;
        setLocalPerson({ ...localPerson, [key]: value });
      }
    ),
    [localPerson],
  );

  const handleSave = useCallback(
    async () => {
      localPerson.firstName = localPerson.firstName.trim();
      localPerson.lastName = localPerson.lastName.trim();
      localPerson.email = localPerson.email.trim();
      localPerson.phone = localPerson.phone.trim();
      vault?.store(localPerson);
      dispatch(updateItems([localPerson]));
      onClose();
    },
    [dispatch, localPerson, onClose, vault],
  );

  const valid = !!localPerson.firstName && !!localPerson.lastName;

  return (
    <Drawer
      className={classes.drawer}
      variant="temporary"
      open={open}
      onClose={handleSave}
      anchor="right"
      classes={{
        paper: classes.drawerPaper,
      }}
    >
      <Container>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.firstName}
              onChange={handleChange('firstName')}
              label="First Name"
              required
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.lastName}
              onChange={handleChange('lastName')}
              label="Last Name"
              required
              fullWidth
            />
          </Grid>

          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.email}
              onChange={handleChange('email')}
              label="Email"
              fullWidth
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              value={localPerson.phone}
              onChange={handleChange('phone')}
              label="Phone"
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            <TextField
              value={localPerson.description}
              onChange={handleChange('description')}
              label="Description"
              multiline
              fullWidth
            />
          </Grid>

          <Grid item xs={12}>
            {JSON.stringify(localPerson.notes)}
          </Grid>

          <Grid item xs={12}>
            <Button
              color="primary"
              onClick={handleSave}
              variant="contained"
              disabled={!valid}
            >
              Done
            </Button>
          </Grid>
        </Grid>
      </Container>
    </Drawer>
  );
}

export default PersonDrawer;
