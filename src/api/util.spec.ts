const authState = vi.hoisted(() => ({ account: 'acct1', loggedIn: false, initializing: false }))

vi.mock('../state/store', () => ({
  useAppStore: Object.assign(
    () => authState,
    {
      getState: () => authState,
    }
  )
}))

import { getAccountId } from './util'

describe('api util', () => {
  it('getAccountId returns account when set', () => {
    authState.account = 'acct1'
    expect(getAccountId()).toBe('acct1')
  })

  it('getAccountId throws when account not set', () => {
    authState.account = ''
    expect(() => getAccountId()).toThrow('Account ID not set')
  })
})
