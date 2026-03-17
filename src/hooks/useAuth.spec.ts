import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '../state/authStore'
import { useAuth } from './useAuth'

describe('useAuth', () => {
  beforeEach(() => {
    useAuthStore.getState().setAccount({
      account: '',
      loggedIn: false,
      initializing: true,
    })
  })

  it('returns auth values from the Zustand store', () => {
    useAuthStore.getState().setAccount({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })

    const { result } = renderHook(() => useAuth())

    expect(result.current).toEqual({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })
  })

  it('reacts to store updates', () => {
    const { result } = renderHook(() => useAuth())

    act(() => {
      useAuthStore.getState().setAccount({ account: 'acct-2', loggedIn: true, initializing: false })
    })

    expect(result.current.account).toBe('acct-2')
    expect(result.current.loggedIn).toBe(true)
    expect(result.current.initializing).toBe(false)
  })
})