import { useEffect, useState } from 'react'
import type { ZXCVBNScore, ZXCVBNResult } from 'zxcvbn'
import customDomainWords from '../utils/customDomainWords'

const MIN_PASSWORD_LENGTH = 10
const MIN_PASSWORD_STRENGTH = 3

export interface PasswordFeedback {
  score: number,
  error: string,
  feedback: ZXCVBNResult['feedback'],
}

async function scorePassword(password: string) {
  const { default: zxcvbn } = await import('zxcvbn')
  const mainScore = zxcvbn(password, customDomainWords)
  const harshScore = zxcvbn(password.slice(3), customDomainWords)
  mainScore.score = Math.min(mainScore.score, harshScore.score) as ZXCVBNScore
  return mainScore
}

export function usePasswordStrength(password: string): PasswordFeedback {
  const [score, setScore] = useState(0)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState<ZXCVBNResult['feedback']>({ warning: '', suggestions: [] })

  // Reset state if password is empty (i.e. don't score blank passwords)
  if (!password) {
    setScore(0)
    setError('')
    setFeedback({ warning: '', suggestions: [] })
  }

  useEffect(() => {
    let cancelled = false
    if (password) {
      scorePassword(password).then(passwordStrength => {
        if (cancelled) return
        setScore(Math.max(passwordStrength.score, 1))
        setFeedback(passwordStrength.feedback)

        if (password.length < MIN_PASSWORD_LENGTH) {
          setError(`Please use a password that is at least ${MIN_PASSWORD_LENGTH} characters long`)
        } else if (passwordStrength.feedback.warning) {
          setError(passwordStrength.feedback.warning)
        } else if (passwordStrength.score < MIN_PASSWORD_STRENGTH) {
          setError('Please choose a stronger password')
        } else {
          setError('')
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [password])

  return { score, error, feedback }
}
