import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

let s3ClientInstance: S3Client | null = null

export function getS3Client(): S3Client {
  if (!s3ClientInstance) {
    s3ClientInstance = new S3Client({
      region: process.env.AWS_REGION || 'ap-southeast-2',
    })
  }
  return s3ClientInstance
}

export function setS3Client(client: S3Client | null): void {
  s3ClientInstance = client
}

export function getSnapshotBucketName(): string {
  return (
    process.env.SNAPSHOTS_BUCKET_NAME ||
    process.env.SNAPSHOT_BUCKET_NAME ||
    'VaultSnapshots'
  )
}

export async function putSnapshotBlob(
  key: string,
  data: Buffer | Uint8Array,
  contentType = 'application/octet-stream',
): Promise<void> {
  const client = getS3Client()
  const bucket = getSnapshotBucketName()
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }),
  )
}

export async function getSnapshotPresignedUrl(
  key: string,
  expiresInSeconds = 900,
): Promise<string> {
  const client = getS3Client()
  const bucket = getSnapshotBucketName()
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  })
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

export async function deleteSnapshotBlob(key: string): Promise<void> {
  const client = getS3Client()
  const bucket = getSnapshotBucketName()
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    )
  } catch (error) {
    console.error(`[blobStore] Failed to delete blob for key: ${key}`, error)
  }
}
