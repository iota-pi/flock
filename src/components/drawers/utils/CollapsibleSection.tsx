import {
  ReactNode,
  useCallback,
  useState,
} from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionActions from '@mui/material/AccordionActions'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'
import { styled } from '@mui/material/styles'

import { ExpandIcon, MuiIconType } from '../../Icons'

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

interface Props {
  icon?: MuiIconType,
  id: string,
  initialExpanded?: boolean,
  title: string,
  content: ReactNode,
  actions?: ReactNode,
  disabled?: boolean,
}


function CollapsibleSection({
  icon: Icon,
  id,
  initialExpanded = true,
  title,
  content,
  actions,
  disabled,
}: Props) {
  const [expanded, setExpanded] = useState<boolean>(initialExpanded)

  const handleChange = useCallback(() => setExpanded(e => !e), [])

  return (
    <StyledAccordion
      data-cy={`section-${id}`}
      elevation={3}
      expanded={expanded}
      onChange={handleChange}
      square
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
    >
      <StyledAccordionSummary
        aria-controls={`${id}-content`}
        expandIcon={<ExpandIcon />}
      >
        <Box sx={{
          mr: 2
        }}>
          {Icon && (
            <Icon />
          )}
        </Box>

        <Typography>{title}</Typography>
      </StyledAccordionSummary>
      <Divider />
      <StyledAccordionDetails>
        <Box sx={{
          flexGrow: 1
        }}>
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
