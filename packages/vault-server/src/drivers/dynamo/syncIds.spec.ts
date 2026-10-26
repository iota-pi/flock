import { parseSyncId, toSyncId } from './syncIds'

describe('sync IDs', () => {
  it('round-trips an account and item ID', () => {
    expect(toSyncId('acct', 'item-1')).toBe('acct#item-1')
    expect(parseSyncId(toSyncId('acct', 'item-1'))).toEqual({ account: 'acct', itemId: 'item-1' })
  })

  it('keeps everything after the first # as the item ID', () => {
    expect(parseSyncId(toSyncId('acct', 'a#b#c'))).toEqual({ account: 'acct', itemId: 'a#b#c' })
  })

  it('returns an empty item ID for a bare prefix, and undefined without a #', () => {
    expect(parseSyncId('acct#')).toEqual({ account: 'acct', itemId: '' })
    expect(parseSyncId('acct')).toBeUndefined()
  })
})
