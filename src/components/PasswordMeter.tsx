import {
  alpha,
  LinearProgress,
  styled,
  Theme,
  Typography,
} from '@mui/material'
import InlineText from './InlineText'

function passwordScoreToWord(score: number) {
  const words = ['', 'very bad', 'not good', 'passable', 'okay']
  return words[Math.min(score, words.length - 1)] || ''
}

function passwordScoreToColour(score: number, theme: Theme) {
  const words = [
    theme.palette.error.main,
    theme.palette.error.main,
    theme.palette.error.main,
    theme.palette.warning.main,
    theme.palette.success.main,
  ]
  return words[Math.min(score, words.length - 1)]
}

const MeterHolder = styled('div')(({ theme }) => ({
  marginTop: theme.spacing(1),
  marginBottom: theme.spacing(1),
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
}))

const StyledLinearProgress = styled(LinearProgress)<{ strength: number }>(({ strength, theme }) => {
  const colour = passwordScoreToColour(strength, theme)
  return {
    height: 2,
    flexGrow: 1,
    marginLeft: theme.spacing(2),

    backgroundColor: alpha(colour, 0.5),
    '& .MuiLinearProgress-bar': {
      backgroundColor: colour,
    },
  }
})

export interface PasswordMeterProps {
  score: number
}

export default function PasswordMeter({ score }: PasswordMeterProps) {
  return (
    <MeterHolder>
      <Typography>
        Password Strength:
        {' '}
        <InlineText fontWeight={500}>
          {passwordScoreToWord(score)}
        </InlineText>
      </Typography>

      <StyledLinearProgress
        strength={score}
        value={score * 25}
        variant="determinate"
      />
    </MeterHolder>
  )
}
