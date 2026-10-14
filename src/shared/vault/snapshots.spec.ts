import { VaultSnapshotSchema } from './snapshots'

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
})
