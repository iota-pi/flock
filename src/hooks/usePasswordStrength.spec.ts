import { renderHook, waitFor } from '@testing-library/react'
import * as zxcvbnCore from '@zxcvbn-ts/core'
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core'
import { usePasswordStrength } from './usePasswordStrength'

describe('usePasswordStrength', () => {
  // The hook imports these dictionaries before its first score. Loading them takes most of a second,
  // and longer under load, which would use up `waitFor`'s 1s, so load them before the tests run.
  beforeAll(async () => {
    await Promise.all([import('@zxcvbn-ts/language-common'), import('@zxcvbn-ts/language-en')])
  })

  beforeEach(() => {
    vi.spyOn(zxcvbnOptions, 'setOptions').mockImplementation(() => {})
    vi.spyOn(zxcvbnCore, 'zxcvbn').mockReturnValue({
      score: 4,
      feedback: { warning: '', suggestions: [] },
    } as unknown as ReturnType<typeof zxcvbn>)
  })

  it('returns default state initially', () => {
    const { result } = renderHook(() => usePasswordStrength(''))
    expect(result.current as any).toEqual({
      score: 0,
      error: '',
      feedback: { warning: '', suggestions: [] },
      scoredPassword: '',
    })
  })

  it('returns default state for empty password', async () => {
    // Even if we wait, empty password shouldn't trigger zxcvbn
    const { result } = renderHook(() => usePasswordStrength(''))
    await waitFor(() => {
      expect(result.current.score).toBe(0)
    })
    expect(zxcvbn).not.toHaveBeenCalled()
  })

  it('calculates score for a valid password', async () => {
    (zxcvbn as any).mockReturnValue({
      score: 3,
      feedback: { warning: '', suggestions: [] }
    })

    const { result } = renderHook(() => usePasswordStrength('correct-horse-battery-staple'))

    // Initially loading/default
    expect(result.current.score).toBe(0)

    // Wait for the async effect
    await waitFor(() => {
      expect(result.current.score).toBe(3)
    })

    expect(zxcvbn).toHaveBeenCalledTimes(2) // Once for mainScore, once for harshScore
  })

  it('returns error for short password', async () => {
    (zxcvbn as any).mockReturnValue({
      score: 4,
      feedback: { warning: '', suggestions: [] }
    })
    const shortPass = 'short'
    const { result } = renderHook(() => usePasswordStrength(shortPass))

    await waitFor(() => {
      expect(result.current.error).toMatch(/at least 10 characters/)
    })
  })

  it('returns error for weak password score', async () => {
    (zxcvbn as any).mockReturnValue({
      score: 2, // Less than MIN_PASSWORD_STRENGTH (3)
      feedback: { warning: '', suggestions: [] }
    })

    const { result } = renderHook(() => usePasswordStrength('weakpassword123'))

    await waitFor(() => {
      expect(result.current.error).toBe('Please choose a stronger password')
    })
  })

  it('returns error from zxcvbn feedback warning', async () => {
    (zxcvbn as any).mockReturnValue({
      score: 2,
      feedback: { warning: 'This is a common password', suggestions: [] }
    })

    const { result } = renderHook(() => usePasswordStrength('password123'))

    await waitFor(() => {
      expect(result.current.error).toBe('This is a common password')
    })
  })

  it('initializes options only once', async () => {
    (zxcvbn as any).mockReturnValue({
      score: 4,
      feedback: { warning: '', suggestions: [] }
    })

    const { result, rerender } = renderHook(({ pw }) => usePasswordStrength(pw), {
      initialProps: { pw: 'passwordOne' }
    })

    await waitFor(() => expect(result.current.score).toBe(4))

    const setOptionsMock = zxcvbnOptions.setOptions
    const initialCallCount = (setOptionsMock as any).mock.calls.length

    rerender({ pw: 'passwordTwo' })
    await waitFor(
      () => expect(result.current.scoredPassword).toBe('passwordTwo'),
    )
    expect(setOptionsMock).toHaveBeenCalledTimes(initialCallCount)
  })
})
