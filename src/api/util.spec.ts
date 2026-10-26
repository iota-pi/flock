import { getAccountId } from './util'
import { useAppStore } from '../state/store'

describe('api util', () => {
  it('getAccountId returns account when set', () => {
    useAppStore.setState({ account: 'acct1' })
    expect(getAccountId()).toBe('acct1')
  })

  it('getAccountId throws when account not set', () => {
    useAppStore.setState({ account: '' })
    expect(() => getAccountId()).toThrow('Account ID not set')
  })
})
