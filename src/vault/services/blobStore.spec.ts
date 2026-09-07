import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  putSnapshotBlob,
  getSnapshotPresignedUrl,
  deleteSnapshotBlob,
  getSnapshotBucketName,
  setS3Client,
} from './blobStore'

const mockSend = vi.fn()
const mockS3Client = {
  send: mockSend,
} as any

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.ap-southeast-2.amazonaws.com/test-bucket/test-key?signed=true'),
}))

describe('blobStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setS3Client(mockS3Client)
    process.env.SNAPSHOTS_BUCKET_NAME = 'test-snapshots-bucket'
  })

  it('returns configured bucket name from environment', () => {
    expect(getSnapshotBucketName()).toBe('test-snapshots-bucket')
  })

  it('putSnapshotBlob uploads data to S3', async () => {
    mockSend.mockResolvedValue({})
    const data = Buffer.from('hello world')
    await putSnapshotBlob('snapshots/acc-1/item-1.bin', data)

    expect(mockSend).toHaveBeenCalledTimes(1)
    const command = mockSend.mock.calls[0][0]
    expect(command.input).toEqual({
      Bucket: 'test-snapshots-bucket',
      Key: 'snapshots/acc-1/item-1.bin',
      Body: data,
      ContentType: 'application/octet-stream',
    })
  })

  it('getSnapshotPresignedUrl returns presigned URL', async () => {
    const url = await getSnapshotPresignedUrl('snapshots/acc-1/item-1.bin', 600)
    expect(url).toContain('https://s3.ap-southeast-2.amazonaws.com/test-bucket/test-key')
  })

  it('deleteSnapshotBlob deletes object from S3', async () => {
    mockSend.mockResolvedValue({})
    await deleteSnapshotBlob('snapshots/acc-1/item-1.bin')

    expect(mockSend).toHaveBeenCalledTimes(1)
    const command = mockSend.mock.calls[0][0]
    expect(command.input).toEqual({
      Bucket: 'test-snapshots-bucket',
      Key: 'snapshots/acc-1/item-1.bin',
    })
  })
})
