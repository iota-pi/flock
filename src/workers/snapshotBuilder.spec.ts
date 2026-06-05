import { buildSnapshot } from './snapshotBuilder'

const mockEncryptBytes = vi.fn()
const mockNormalizeItemSnapshot = vi.fn()
const mockSave = vi.fn()
const mockToAutomergeUrlFromItemId = vi.fn()

vi.mock('src/api/vault', () => ({
  encryptBytes: (...args: any[]) => mockEncryptBytes(...args),
}))

vi.mock('@automerge/automerge/slim', () => ({
  save: (...args: any[]) => mockSave(...args),
}))

vi.mock('../sync/automergeDocStore', () => ({
  normalizeItemSnapshot: (...args: any[]) => mockNormalizeItemSnapshot(...args),
}))

vi.mock('../sync/automergeRepoIds', () => ({
  toAutomergeUrlFromItemId: (...args: any[]) => mockToAutomergeUrlFromItemId(...args),
}))

describe('buildSnapshot helper function', () => {
  let mockRepo: any
  let mockHandle: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockHandle = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn().mockReturnValue(true),
      isUnavailable: vi.fn().mockReturnValue(false),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'topic' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    mockToAutomergeUrlFromItemId.mockResolvedValue('automerge:item-1')
    mockSave.mockReturnValue(new Uint8Array([1, 2, 3]))
    mockEncryptBytes.mockResolvedValue({
      iv: 'mock-iv',
      cipher: 'mock-cipher',
      kver: '1',
    })
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
    })
  })

  it('builds a snapshot successfully under normal conditions', async () => {
    const result = await buildSnapshot(mockRepo, 'item-1', 42)

    expect(result).toEqual({
      itemId: 'item-1',
      snapshot: { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' },
      snapshotCursor: 42,
      type: 'topic',
      modified: expect.any(Number),
      deleted: undefined,
    })

    expect(mockToAutomergeUrlFromItemId).toHaveBeenCalledWith('item-1')
    expect(mockRepo.find).toHaveBeenCalledWith('automerge:item-1')
    expect(mockHandle.whenReady).toHaveBeenCalledWith(['ready', 'unavailable'])
    expect(mockSave).toHaveBeenCalledWith({ id: 'item-1', type: 'topic' })
    expect(mockEncryptBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(mockNormalizeItemSnapshot).toHaveBeenCalledWith('item-1', { id: 'item-1', type: 'topic' })
  })

  it('returns null if repo.find throws or returns undefined', async () => {
    mockRepo.find.mockRejectedValue(new Error('not found'))
    let result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()

    mockRepo.find.mockResolvedValue(undefined)
    result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()
  })

  it('returns null if document handle is not ready or is unavailable', async () => {
    mockHandle.isReady.mockReturnValue(false)
    let result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()

    mockHandle.isReady.mockReturnValue(true)
    mockHandle.isUnavailable.mockReturnValue(true)
    result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()
  })

  it('returns null if doc is missing or saving binary is empty', async () => {
    mockHandle.doc.mockReturnValue(undefined)
    let result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()

    mockHandle.doc.mockReturnValue({ id: 'item-1' })
    mockSave.mockReturnValue(new Uint8Array([]))
    result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()
  })

  it('returns null if normalizeItemSnapshot returns null', async () => {
    mockNormalizeItemSnapshot.mockReturnValue(null)
    const result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result).toBeNull()
  })

  it('correctly reports deleted status if document is deleted', async () => {
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
      deleted: true,
    })

    const result = await buildSnapshot(mockRepo, 'item-1', 42)
    expect(result?.deleted).toBe(true)
  })

  it('propagates encryptBytes exception (caller handles it)', async () => {
    const error = new Error('Crypto error')
    mockEncryptBytes.mockRejectedValue(error)

    await expect(buildSnapshot(mockRepo, 'item-1', 42)).rejects.toThrow('Crypto error')
  })
})
