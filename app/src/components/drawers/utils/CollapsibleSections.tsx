import {
  ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionActions,
  Typography,
  Divider,
} from '@material-ui/core';
import ExpandMoreIcon from '@material-ui/icons/ExpandMore';
import { MuiIconType } from '../../Icons';


const useStyles = makeStyles(theme => ({
  root: {
    display: 'block',
    flexGrow: 1,
  },
  details: {
    flexGrow: 1,
  },
  accordionRoot: {
    margin: theme.spacing(2, 0),
  },
  accordionExpanded: {
    margin: theme.spacing(2, 0),
    '&$accordionRoot:first-child': {
      marginTop: theme.spacing(2),
    },
  },
  summaryExpanded: {},
  summaryContent: {
    '&$summaryExpanded': {
      margin: theme.spacing(1.5, 0),
    },
  },
  summaryRoot: {
    '&$summaryExpanded': {
      minHeight: theme.spacing(6),
    },
  },
  detailsRoot: {
    padding: theme.spacing(2),
  },
  icon: {
    marginRight: theme.spacing(2),
  },
}));

export interface CollapsibleSection {
  icon?: MuiIconType,
  id: string,
  title: string,
  content: ReactNode,
  actions?: ReactNode,
}

export interface Props {
  initialExpandAll?: boolean,
  sections: CollapsibleSection[],
}


function CollapsibleSections({
  initialExpandAll = false,
  sections,
}: Props) {
  const classes = useStyles();
  const [expanded, setExpanded] = useState<string[]>([]);

  const handleChange = useCallback(
    (section: string) => () => setExpanded(
      e => (
        e.includes(section)
          ? e.filter(s => s !== section)
          : [...e, section]
      ),
    ),
    [],
  );

  useEffect(
    () => {
      if (initialExpandAll) {
        setExpanded(sections.map(s => s.id));
      }
    },
    [initialExpandAll, sections],
  );

  return (
    <div className={classes.root}>
      {sections.map(section => (
        <Accordion
          classes={{
            root: classes.accordionRoot,
            expanded: classes.accordionExpanded,
          }}
          expanded={expanded.includes(section.id)}
          key={section.id}
          onChange={handleChange(section.id)}
          square
        >
          <AccordionSummary
            aria-controls={`${section.id}-content`}
            classes={{
              content: classes.summaryContent,
              expanded: classes.summaryExpanded,
              root: classes.summaryRoot,
            }}
            data-cy={`section-${section.id}`}
            expandIcon={<ExpandMoreIcon />}
          >
            {section.icon && (
              <div className={classes.icon}>
                <section.icon />
              </div>
            )}

            <Typography>{section.title}</Typography>
          </AccordionSummary>

          <Divider />

          <AccordionDetails className={classes.detailsRoot}>
            <div className={classes.details}>
              {section.content}
            </div>
          </AccordionDetails>

          {section.actions && (
            <AccordionActions>
              {section.actions}
            </AccordionActions>
          )}
        </Accordion>
      ))}
    </div>
  );
}

export default CollapsibleSections;
