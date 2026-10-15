/**
 * Puts an existing local account back at data level 0, for testing the migration app (src/migrate/)
 * by hand. It adds a pre-Automerge `cipher` item and plaintext settings, and resets `dataVersion`.
 *
 *   ACCOUNT=... PASSWORD=... yarn tsx scripts/seedLegacyAccount.ts
 *
 * Local DynamoDB only: it refuses to run against any other endpoint.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { getConnectionParams } from '@vault/server/dynamo'
import { generateItemId } from '@vault/shared'

const { ACCOUNT, PASSWORD } = process.env
const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000'
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE || 'FlockAccounts'
const ITEMS_TABLE = process.env.ITEMS_TABLE || 'FlockItems'
const DEFAULT_ITERATIONS = 600_000

if (!ACCOUNT || !PASSWORD) {
  console.error('ACCOUNT and PASSWORD are required.')
  process.exit(1)
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(ENDPOINT)) {
  console.error(`Refusing to seed legacy data at ${ENDPOINT}: local DynamoDB only.`)
  process.exit(1)
}
process.env.DYNAMODB_ENDPOINT = ENDPOINT

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient(getConnectionParams()), {
  marshallOptions: { removeUndefinedValues: true },
})

/** The account's key `'1'`, derived as the client does for `saltVersion` 1 */
async function deriveKey(salt: string, iterations: number): Promise<CryptoKey> {
  const keyBase = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: Uint8Array.fromBase64(salt), iterations, hash: 'SHA-256' },
    keyBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
}

async function seed() {
  const { Item: accountRow } = await docClient.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { account: ACCOUNT } }))
  if (!accountRow) throw new Error(`No account ${ACCOUNT}`)
  if (accountRow.saltVersion !== 1) throw new Error('Expected an account with saltVersion 1')

  const key = await deriveKey(accountRow.salt as string, (accountRow.iterations as number) ?? DEFAULT_ITERATIONS)
  const now = Date.now()
  const itemId = generateItemId()
  const item = {
    id: itemId,
    type: 'person',
    name: 'Legacy Person',
    description: 'Stored in the pre-Automerge cipher format',
    archived: false,
    created: now,
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(item)))

  await docClient.send(new PutCommand({
    TableName: ITEMS_TABLE,
    Item: {
      account: ACCOUNT,
      item: itemId,
      cipher: new Uint8Array(cipher).toBase64(),
      metadata: { iv: iv.toBase64(), kver: '1', modified: now },
      version: 1,
      modifiedAt: now,
    },
  }))

  await docClient.send(new UpdateCommand({
    TableName: ACCOUNTS_TABLE,
    Key: { account: ACCOUNT },
    UpdateExpression: 'SET dataVersion = :zero, metadata = :metadata',
    ExpressionAttributeValues: {
      ':zero': 0,
      ':metadata': { prayerGoal: 7, updatedAt: now },
    },
  }))

  console.info(`Seeded legacy item ${itemId} and plaintext settings; ${ACCOUNT} is at data level 0.`)
}

seed().catch(error => {
  console.error(error)
  process.exit(1)
})
