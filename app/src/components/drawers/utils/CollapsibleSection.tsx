import {
  ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react'
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  AccordionActions,
  Typography,
  Divider,
  Box,
  styled,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { MuiIconType } from '../../Icons'

const StyledAccordion = styled(Accordion)(({ theme }) => ({
  '& .MuiAccordion-root': {
    margin: theme.spacing(2, 0),

    // Hide grey line above accordion when not expanded
    '&::before': {
      content: 'unset',
    },
  },
  '&.Mui-expanded': {
    margin: theme.spacing(2, 0),
  },
}))
const StyledAccordionSummary = styled(AccordionSummary)(({ theme }) => ({
  '& .MuiAccordionSummary-content': {
    alignItems: 'center',

    '&.Mui-expanded': {
      margin: theme.spacing(1.5, 0),
    },
  },
  '& .MuiAccordionSummary-root': {
    '&.Mui-expanded': {
      minHeight: theme.spacing(6),
    },
  },
}))
const StyledAccordionDetails = styled(AccordionDetails)(({ theme }) => ({
  padding: theme.spacing(2),
}))

export interface Props {
  icon?: MuiIconType,
  id: string,
  initialExpanded?: boolean,
  title: string,
  content: ReactNode,
  actions?: ReactNode,
}


function CollapsibleSection({
  icon: Icon,
  id,
  initialExpanded = false,
  title,
  content,
  actions,
}: Props) {
  const [expanded, setExpanded] = useState<boolean>(false)

  const handleChange = useCallback(() => setExpanded(e => !e), [])

  useEffect(
    () => {
      if (initialExpanded) {
        setExpanded(true)
      }
    },
    [initialExpanded],
  )

  return (
    <StyledAccordion
      data-cy={`section-${id}`}
      elevation={3}
      expanded={expanded}
      onChange={handleChange}
      square
      TransitionProps={{ unmountOnExit: true }}
    >
      <StyledAccordionSummary
        aria-controls={`${id}-content`}
        expandIcon={<ExpandMoreIcon />}
      >
        <Box mr={2}>
          {Icon && (
            <Icon />
          )}
        </Box>

        <Typography>{title}</Typography>
      </StyledAccordionSummary>

      <Divider />

      <StyledAccordionDetails>
        <Box flexGrow={1}>
          {content}
        </Box>
      </StyledAccordionDetails>

      {actions && (
        <AccordionActions>
          {actions}
        </AccordionActions>
      )}
    </StyledAccordion>
  )
}

export default CollapsibleSection
