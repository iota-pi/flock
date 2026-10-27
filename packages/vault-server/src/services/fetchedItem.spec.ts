import { toFetchedItem } from './fetchedItem'
import type { VaultItem } from '../drivers/vaultDriver'

describe('toFetchedItem', () => {
  it('sends a snapshot row without its legacy cipher', () => {
    const record: VaultItem = {
      account: 'acct',
      item: 'item-1',
      metadata: { iv: '', modified: 1 },
      cipher: 'legacy',
      snapshot: { iv: 'iv', cipher: 'c2FtcGxl', kver: '2' },
      version: 4,
    }

    expect(toFetchedItem(record)).toEqual({
      item: 'item-1',
      metadata: { iv: '', modified: 1 },
      snapshot: { iv: 'iv', cipher: 'c2FtcGxl', kver: '2' },
      version: 4,
    })
  })

  it('sends a snapshot without a ciphertext with an empty one, so it fails to decrypt', () => {
    const record: VaultItem = {
      account: 'acct',
      item: 'item-1',
      metadata: { iv: '', modified: 1 },
      snapshot: { iv: 'iv' },
    }

    expect(toFetchedItem(record)).toMatchObject({ snapshot: { iv: 'iv', cipher: '' } })
  })

  it('passes legacy metadata through whole', () => {
    const metadata = { iv: 'iv', modified: 1, kver: '1' }
    const record = { account: 'acct', item: 'item-1', metadata, cipher: 'legacy' } as VaultItem

    expect(toFetchedItem(record)).toEqual({ item: 'item-1', metadata, cipher: 'legacy', version: undefined })
  })

  it('sends a tombstone with neither payload', () => {
    const record: VaultItem = { account: 'acct', item: 'item-1', metadata: { iv: '', modified: 1, deleted: true } }

    expect(toFetchedItem(record)).toEqual({
      item: 'item-1',
      metadata: { iv: '', modified: 1, deleted: true },
      version: undefined,
    })
  })
})
