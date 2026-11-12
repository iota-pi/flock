import { DEVICE_TOKEN_LENGTH } from '@vault/shared'
import { getVaultStorageNames } from '../shared/storageNames'
import { clearDeviceToken, generateDeviceToken, loadDeviceToken, rememberDeviceToken } from './deviceToken'

function randomKeyHash(): string {
  return crypto.getRandomValues(new Uint8Array(64)).toBase64()
}

describe('device token', () => {
  const keyHash = randomKeyHash()

  beforeEach(() => {
    clearDeviceToken()
  })

  afterAll(() => {
    clearDeviceToken()
  })

  it('generates tokens of the length the server accepts', () => {
    const token = generateDeviceToken()
    expect(token).toHaveLength(DEVICE_TOKEN_LENGTH)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generateDeviceToken()).not.toBe(token)
  })

  it('makes a new token when none is stored', async () => {
    const device = await loadDeviceToken('acct-1', keyHash)
    expect(device.stored).toBe(false)
    expect(device.token).toHaveLength(DEVICE_TOKEN_LENGTH)
  })

  it('opens a remembered token with the same key hash and account', async () => {
    const token = generateDeviceToken()
    await rememberDeviceToken('acct-1', keyHash, token)

    await expect(loadDeviceToken('acct-1', keyHash)).resolves.toEqual({ token, stored: true })
  })

  it('stores the token sealed', async () => {
    const token = generateDeviceToken()
    await rememberDeviceToken('acct-1', keyHash, token)

    const raw = localStorage.getItem(getVaultStorageNames().loginDeviceKey)
    expect(raw).toBeTruthy()
    expect(raw).not.toContain(token)
  })

  it('makes a new token for another password or another account', async () => {
    const token = generateDeviceToken()
    await rememberDeviceToken('acct-1', keyHash, token)

    const otherPassword = await loadDeviceToken('acct-1', randomKeyHash())
    expect(otherPassword.stored).toBe(false)
    expect(otherPassword.token).not.toBe(token)

    const otherAccount = await loadDeviceToken('acct-2', keyHash)
    expect(otherAccount.stored).toBe(false)
    expect(otherAccount.token).not.toBe(token)
  })

  it('treats an unreadable stored record as missing', async () => {
    localStorage.setItem(getVaultStorageNames().loginDeviceKey, 'not json')
    await expect(loadDeviceToken('acct-1', keyHash)).resolves.toMatchObject({ stored: false })
  })
})
