/**
 * Puts an existing local account back at data level 0, for testing the migration app (src/migrate/)
 * by hand. It adds a pre-Automerge `cipher` item and plaintext settings, and resets `dataVersion`.
 *
 * An account created with Argon2id (as new accounts are) is first turned back into a PBKDF2 one:
 * new credentials for the same password, and a keyring whose key `'1'` is the PBKDF2 master key, as
 * accounts had before random data keys. Use a freshly created account with no items for that, and
 * remove it from the device first: anything encrypted with its old random key can't be read after.
 *
 *   ACCOUNT=... PASSWORD=... yarn tsx scripts/seedLegacyAccount.ts
 *
 * Local DynamoDB only: it refuses to run against any other endpoint.
 */
import { createHash } from 'node:crypto'
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

/** The account's PBKDF2 master key, derived as the client does for `saltVersion` 1 */
async function deriveKeyBytes(salt: string, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const keyBase = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: Uint8Array.fromBase64(salt), iterations, hash: 'SHA-256' },
    keyBase,
    256,
  )
  return new Uint8Array(bits)
}

function importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
}

async function encrypt(key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return { iv: iv.toBase64(), cipher: new Uint8Array(cipher).toBase64() }
}

/** Replaces an Argon2id account's credentials and keyring with PBKDF2 ones for the same password */
async function convertToPbkdf2(): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16)).toBase64()
  const raw = await deriveKeyBytes(salt, DEFAULT_ITERATIONS)
  const masterKey = await importKey(raw)
  // The client sends SHA-512 of the master key, and the server stores a SHA-512 of that
  const clientAuthToken = createHash('sha512').update(raw).digest('base64')
  const storedAuthToken = createHash('sha512').update(clientAuthToken).digest('base64')
  const keyringJson = JSON.stringify({ activeVersion: '1', '1': raw.toBase64() })
  const keyring = { ...await encrypt(masterKey, new TextEncoder().encode(keyringJson)), kver: 'master' }

  await docClient.send(new UpdateCommand({
    TableName: ACCOUNTS_TABLE,
    Key: { account: ACCOUNT },
    UpdateExpression: 'SET salt = :salt, iterations = :iterations, saltVersion = :saltVersion, authToken = :authToken, '
      + 'keyring = :keyring, keyringVersion = :keyringVersion, sessions = :sessions REMOVE kdf, randomDataKeys',
    ExpressionAttributeValues: {
      ':salt': salt,
      ':iterations': DEFAULT_ITERATIONS,
      ':saltVersion': 1,
      ':authToken': storedAuthToken,
      ':keyring': JSON.stringify(keyring),
      ':keyringVersion': 1,
      ':sessions': [],
    },
  }))
  console.info(`Converted ${ACCOUNT} to PBKDF2 with a password-derived key '1'.`)
}

async function seed() {
  const { Item: existingRow } = await docClient.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { account: ACCOUNT } }))
  if (!existingRow) throw new Error(`No account ${ACCOUNT}`)
  if (existingRow.saltVersion !== 1) throw new Error('Expected an account with saltVersion 1')
  if (existingRow.kdf) {
    await convertToPbkdf2()
  }

  const { Item: accountRow } = await docClient.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { account: ACCOUNT } }))
  const key = await importKey(await deriveKeyBytes(accountRow!.salt as string, (accountRow!.iterations as number) ?? DEFAULT_ITERATIONS))
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
  const { iv, cipher } = await encrypt(key, new TextEncoder().encode(JSON.stringify(item)))

  await docClient.send(new PutCommand({
    TableName: ITEMS_TABLE,
    Item: {
      account: ACCOUNT,
      item: itemId,
      cipher,
      metadata: { iv, kver: '1', modified: now },
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
