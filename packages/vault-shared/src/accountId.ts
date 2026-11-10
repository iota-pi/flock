/**
 * Account IDs. New accounts get 8 random characters of Crockford base32 (40 bits), so the IDs in use
 * can't be found by trying them all. Two older formats keep working unchanged: the first accounts
 * have a version 4 UUID (`xxxxxxxx-xxxx-4xxx-xxxx-xxxxxxxxxxxx`), and later ones have 4 characters
 * of `[a-z0-9]`.
 *
 * The canonical form, which is stored, sent to the server and used in storage names, is lowercase
 * with no separators, except that UUID IDs keep their hyphens as they were stored.
 * `formatAccountId` adds the hyphen people see to current IDs.
 */

/** Crockford base32, which leaves out I, L, O and U so that IDs are hard to misread */
export const ACCOUNT_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const ACCOUNT_ID_LENGTH = 8
const LEGACY_ACCOUNT_ID_LENGTH = 4

const NEW_ACCOUNT_ID_PATTERN = new RegExp(`^[${ACCOUNT_ID_ALPHABET}]{${ACCOUNT_ID_LENGTH}}$`)
const LEGACY_ACCOUNT_ID_PATTERN = new RegExp(`^[a-z0-9]{${LEGACY_ACCOUNT_ID_LENGTH}}$`)
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/
const UUID_ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Characters Crockford base32 reads as the digit they look like */
const LOOKALIKES: Record<string, string> = { i: '1', l: '1', o: '0' }

/**
 * Turns an account ID as someone typed or pasted it into its canonical form. Case, spaces and
 * hyphens don't matter. In a new-length ID, the letters I, L and O are read as 1, 1 and 0. Legacy
 * IDs can contain those letters, so they're only lowercased, and UUIDs get their hyphens back.
 */
export function normalizeAccountId(input: string): string {
  const compact = input.trim().toLowerCase().replace(/[\s-]/g, '')
  if (UUID_HEX_PATTERN.test(compact)) {
    return [
      compact.slice(0, 8),
      compact.slice(8, 12),
      compact.slice(12, 16),
      compact.slice(16, 20),
      compact.slice(20),
    ].join('-')
  }
  if (compact.length !== ACCOUNT_ID_LENGTH) {
    return compact
  }
  return compact.replace(/[ilo]/g, char => LOOKALIKES[char])
}

/** Whether `id` is a canonical account ID in the current format */
export function isValidNewAccountId(id: string): boolean {
  return NEW_ACCOUNT_ID_PATTERN.test(id)
}

/**
 * Why `input` can't be an account ID, or null if it could be one. It only checks the shape, so a
 * well-formed ID that's mistyped still passes.
 */
export function describeAccountIdProblem(input: string): string | null {
  const id = normalizeAccountId(input)
  if (isValidNewAccountId(id) || LEGACY_ACCOUNT_ID_PATTERN.test(id) || UUID_ACCOUNT_ID_PATTERN.test(id)) {
    return null
  }
  if (id.length === ACCOUNT_ID_LENGTH) {
    return 'Account IDs only use the letters and digits 0-9 and a-z, without U. '
      + 'Check it against your password manager.'
  }
  return 'Account IDs have 8 characters, like abcd-1234. Check it against your password manager.'
}

/** How an account ID is shown: `abcd-1234` for current IDs, and legacy IDs as they are */
export function formatAccountId(id: string): string {
  if (!isValidNewAccountId(id)) {
    return id
  }
  const half = ACCOUNT_ID_LENGTH / 2
  return `${id.slice(0, half)}-${id.slice(half)}`
}
