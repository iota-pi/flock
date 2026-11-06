import { VaultSnapshotSchema } from './snapshots'
import { PollLogSchema } from './api'

describe('VaultSnapshotSchema', () => {
  const base = {
    itemId: 'item-1',
    snapshotCursor: 3,
    modified: 1000,
  }
  const cipher = { cipher: 'abc', iv: '123', kver: '1' }

  it('accepts a normal snapshot with a payload', () => {
    expect(VaultSnapshotSchema.safeParse({ ...base, snapshot: cipher }).success).toBe(true)
  })

  it('accepts a deleted tombstone without a payload', () => {
    expect(VaultSnapshotSchema.safeParse({ ...base, deleted: true }).success).toBe(true)
  })

  it('rejects a payload-less snapshot that is not deleted', () => {
    expect(VaultSnapshotSchema.safeParse(base).success).toBe(false)
    expect(VaultSnapshotSchema.safeParse({ ...base, deleted: false }).success).toBe(false)
  })

  // A dropped format flag would leave doc-bound ciphertexts undecryptable
  it('keeps the ciphertext format', () => {
    const parsed = VaultSnapshotSchema.parse({ ...base, snapshot: { ...cipher, format: 2 } })
    expect(parsed.snapshot).toEqual({ ...cipher, format: 2 })
  })

  it('rejects an unknown ciphertext format', () => {
    expect(VaultSnapshotSchema.safeParse({ ...base, snapshot: { ...cipher, format: 3 } }).success).toBe(false)
  })
})

describe('PollLogSchema', () => {
  it('keeps the ciphertext format of pushed messages', () => {
    const encryptedMessage = { iv: 'iv', cipher: 'abc', kver: '1', format: 2, version: '1.0' }
    const parsed = PollLogSchema.parse({
      account: 'acct',
      push: [{ itemId: 'item-1', encryptedMessage }],
      after: 0,
    })
    expect(parsed.push[0].encryptedMessage).toEqual(encryptedMessage)
  })
})
