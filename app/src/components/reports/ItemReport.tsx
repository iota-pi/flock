import { useMemo } from 'react';
import { IconButton, Typography } from '@material-ui/core';
import makeStyles from '@material-ui/styles/makeStyles';
import {
  getItemName,
  getNotes,
  Item,
} from '../../state/items';
import MemberDisplay from '../MemberDisplay';
import GroupDisplay from '../GroupDisplay';
import { EditIcon } from '../Icons';
import NoteList from '../NoteList';
import TagDisplay from '../TagDisplay';
import { getInteractions } from '../../utils/interactions';

const useStyles = makeStyles(theme => ({
  heading: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  editButton: {
    marginTop: theme.spacing(0.5),
    marginLeft: theme.spacing(1),
  },
  section: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),

    '&$lessPadding': {
      paddingTop: theme.spacing(1),
      paddingBottom: theme.spacing(1),
    },
  },
  lessPadding: {},
  subtleHeading: {
    display: 'block',
    fontWeight: 500,
    marginTop: theme.spacing(1),
  },
}));

interface BaseProps {
  item: Item,
}

interface PropsWithEdit extends BaseProps {
  canEdit: true,
  onEdit: () => void,
}

interface PropsNoEdit extends BaseProps {
  canEdit?: false,
  onEdit?: () => void,
}

export type Props = PropsWithEdit | PropsNoEdit;


function ItemReport({
  canEdit,
  item,
  onEdit,
}: Props) {
  const classes = useStyles();

  const prayerPoints = useMemo(
    () => getNotes([item], 'prayer').sort((a, b) => b.date - a.date),
    [item],
  );
  const interactions = useMemo(
    () => (
      item.type === 'person'
        ? getInteractions(item).sort((a, b) => b.date - a.date)
        : []
    ),
    [item],
  );

  return (
    <>
      <div className={classes.heading}>
        <Typography variant="h3">
          {getItemName(item)}
        </Typography>

        {canEdit && (
          <IconButton
            className={classes.editButton}
            data-cy="edit-item-button"
            onClick={onEdit}
            size="large"
          >
            <EditIcon />
          </IconButton>
        )}
      </div>

      {item.description && (
        <Typography color="textSecondary">
          {item.description}
        </Typography>
      )}

      <div className={`${classes.section} ${classes.lessPadding}`}>
        <TagDisplay tags={item.tags} />
      </div>

      {item.summary && (
        <Typography paragraph>
          <span className={classes.subtleHeading}>
            Notes
          </span>
          {item.summary}
        </Typography>
      )}

      <div className={classes.section}>
        <Typography variant="h4">
          Prayer Points
        </Typography>

        <NoteList
          notes={prayerPoints}
          displayItemNames={false}
          displayNoteDate={false}
          dividers
          hideEmpty
          noNotesHint="No prayer points"
        />
      </div>

      {item.type === 'person' && (
        <div className={classes.section}>
          <Typography variant="h4">
            Interactions
          </Typography>

          <NoteList
            notes={interactions}
            displayItemNames={false}
            dividers
            noNotesHint="No interactions"
          />
        </div>
      )}

      {item.type === 'person' && (
        <div className={classes.section}>
          <Typography variant="h4">
            Groups
          </Typography>

          <GroupDisplay
            itemId={item.id}
            editable={false}
          />
        </div>
      )}

      {item.type === 'group' && (
        <div className={classes.section}>
          <Typography variant="h4">
            Members
          </Typography>

          <MemberDisplay
            editable={false}
            memberIds={item.members}
            onChange={() => {}}
          />
        </div>
      )}
    </>
  );
}

export default ItemReport;
