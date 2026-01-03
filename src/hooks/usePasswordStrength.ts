import { useEffect, useState } from 'react'
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core'
import type { ZxcvbnResult } from '@zxcvbn-ts/core'
import customDomainWords from '../utils/customDomainWords'

const MIN_PASSWORD_LENGTH = 10
const MIN_PASSWORD_STRENGTH = 3

export interface PasswordFeedback {
  score: number,
  error: string,
  feedback: ZxcvbnResult['feedback'],
}

let optionsSet = false
async function scorePassword(password: string) {
  if (!optionsSet) {
    const { dictionary: commonDictionary, adjacencyGraphs } = await import('@zxcvbn-ts/language-common')
    const { dictionary: enDictionary, translations } = await import('@zxcvbn-ts/language-en')
    zxcvbnOptions.setOptions({
      dictionary: {
        ...commonDictionary,
        ...enDictionary,
      },
      graphs: adjacencyGraphs,
      translations,
    })
    optionsSet = true
  }
  const mainScore = zxcvbn(password, customDomainWords)
  const harshScore = zxcvbn(password.slice(3), customDomainWords)
  mainScore.score = Math.min(mainScore.score, harshScore.score) as ZxcvbnResult['score']
  return mainScore
}

const DEFAULT_RESULT: PasswordFeedback = {
  score: 0,
  error: '',
  feedback: { warning: '', suggestions: [] },
}

export function usePasswordStrength(password: string): PasswordFeedback {
  const [result, setResult] = useState<PasswordFeedback & { scoredPassword?: string }>({
    ...DEFAULT_RESULT,
    scoredPassword: '',
  })

  // Derived state: if password has changed but not yet scored, return defaults
  // This avoids flashing stale data or invalid empty states
  const effectiveResult = password === result.scoredPassword ? result : DEFAULT_RESULT

  useEffect(() => {
    let cancelled = false

    // Only score if there is a password and it's different from what we last scored
    if (password && password !== result.scoredPassword) {
      scorePassword(password).then(passwordStrength => {
        if (cancelled) return

        let error = ''
        if (password.length < MIN_PASSWORD_LENGTH) {
          error = `Please use a password that is at least ${MIN_PASSWORD_LENGTH} characters long`
        } else if (passwordStrength.feedback.warning) {
          error = passwordStrength.feedback.warning
        } else if (passwordStrength.score < MIN_PASSWORD_STRENGTH) {
          error = 'Please choose a stronger password'
        }

        setResult({
          score: Math.max(passwordStrength.score, 1),
          feedback: passwordStrength.feedback,
          error,
          scoredPassword: password,
        })
      })
    }

    return () => {
      cancelled = true
    }
  }, [password, result.scoredPassword])

  return effectiveResult
}
