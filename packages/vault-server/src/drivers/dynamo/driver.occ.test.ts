import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import DynamoDriver from './driver'
import { authenticateLogin, authenticateSession } from '../../authentication'
import { generateAccountId } from '../../util'
import { AuthenticationError, TooManyLoginAttemptsError } from '../../errors'
import { FAILED_LOGIN_WINDOW_MS, MAX_FAILED_LOGINS } from '../../loginThrottle'
import { hashSessionToken, isSessionFor, SESSION_EXPIRY_MS } from '../../sessions'
import { VersionConflictError } from '@vault/shared'

const driver = new DynamoDriver()

async function login(account: string, authTokenHash: string) {
  return authenticateLogin(await driver.getAccountRecord({ account }), authTokenHash)
}

async function getWithSession(account: string, session: string) {
  return authenticateSession(await driver.getAccountRecord({ account }), session)
}

function uniqueAccountId() {
  return `${generateAccountId()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

describe('DynamoDriver conditional account writes', () => {
  beforeAll(() => {
    driver.connect()
  })

  describe('Concurrent Key Rotation & keyringVersion OCC', () => {
    it('allows updating keyringVersion and keyring when expectedKeyringVersion matches', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })

      // createAccount sets keyringVersion: 1
      await driver.updateAccountData({
        account,
        keyringVersion: 2,
        keyring: 'keyring-v2',
        expectedKeyringVersion: 1,
      })

      const acct = await login(account, 'token')
      expect(acct.keyringVersion).toBe(2)
      expect(acct.keyring).toBe('keyring-v2')
    })

    it('rejects update when expectedKeyringVersion does not match current keyringVersion', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })

      // Trying to update with mismatched expectedKeyringVersion should fail conditional check
      await expect(
        driver.updateAccountData({
          account,
          keyringVersion: 2,
          keyring: 'keyring-v2',
          expectedKeyringVersion: 99,
        })
      ).rejects.toBeInstanceOf(VersionConflictError)

      const acct = await login(account, 'token')
      expect(acct.keyringVersion).toBe(1)
      expect(acct.keyring).toBeUndefined()
    })

    it('prevents concurrent key rotation race condition between two devices', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })
      await driver.updateAccountData({ account, keyring: 'initial-keyring' })

      // Device 1 and Device 2 both observed keyringVersion = 1 and attempt rotation
      // Device 1's update arrives first
      await driver.updateAccountData({
        account,
        keyringVersion: 2,
        keyring: 'device-1-keyring',
        expectedKeyringVersion: 1,
      })

      // Device 2's update arrives second with stale expectedKeyringVersion: 1
      await expect(
        driver.updateAccountData({
          account,
          keyringVersion: 2,
          keyring: 'device-2-keyring',
          expectedKeyringVersion: 1,
        })
      ).rejects.toBeInstanceOf(VersionConflictError)

      // Verify Device 1's keyring remains intact and was not overwritten by Device 2
      const acct = await login(account, 'token')
      expect(acct.keyringVersion).toBe(2)
      expect(acct.keyring).toBe('device-1-keyring')
    })

    it('allows legacy accounts without keyringVersion using attribute_not_exists fallback', async () => {
      const account = uniqueAccountId()
      // Simulate a legacy account by creating without keyringVersion
      // We need to create the account and then remove keyringVersion
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })

      // The condition uses attribute_not_exists(keyringVersion) OR keyringVersion = :expected
      // For a newly created account with keyringVersion: 1, expectedKeyringVersion: 1 should succeed
      await driver.updateAccountData({
        account,
        keyringVersion: 2,
        keyring: 'first-rotation-keyring',
        expectedKeyringVersion: 1,
      })

      const updated = await login(account, 'token')
      expect(updated.keyringVersion).toBe(2)
      expect(updated.keyring).toBe('first-rotation-keyring')
    })
  })

  describe('Concurrent Session Extension & sessions OCC', () => {
    it('preserves concurrently added login session when extendSession races with login', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })

      const sessionA = 'session-A'
      const sessionB = 'session-B'
      const initialExpiry = Date.now() + 5000

      await driver.updateAccountData({
        account,
        sessions: [{ token: sessionA, expiry: initialExpiry }],
      })

      let intercepted = false
      const originalSend = driver.client.send.bind(driver.client)
      const sendSpy = vi.spyOn(driver.client, 'send').mockImplementation((async (command: unknown) => {
        const res = await originalSend(command as never)
        if (!intercepted && command instanceof GetCommand && command.input.TableName === driver.tables.accounts) {
          intercepted = true
          // Simulate a concurrent login adding sessionB right after extendSession reads the old sessions list
          await originalSend(new UpdateCommand({
            TableName: driver.tables.accounts,
            Key: { account },
            UpdateExpression: 'SET sessions = :sessions',
            ExpressionAttributeValues: {
              ':sessions': [
                { token: sessionA, expiry: initialExpiry },
                { token: sessionB, expiry: initialExpiry + 60_000 },
              ],
            },
          }))
        }
        return res
      }) as typeof driver.client.send)

      try {
        await driver.extendSession({ account, session: sessionA })

        // Both sessionA and sessionB must remain valid
        const acctViaB = await getWithSession(account, sessionB)
        expect(acctViaB.account).toBe(account)

        const acctViaA = await getWithSession(account, sessionA)
        expect(acctViaA.account).toBe(account)

        const recordA = acctViaA.sessions?.find(s => isSessionFor(s, sessionA))
        const recordB = acctViaA.sessions?.find(s => isSessionFor(s, sessionB))

        expect(recordB).toBeDefined()
        expect(recordA?.expiry).toBeGreaterThan(Date.now() + 10_000)
      } finally {
        sendSpy.mockRestore()
      }
    })

    it('does not resurrect a session that was concurrently revoked (e.g. via changePassword)', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })

      const sessionA = 'session-A'
      const sessionB = 'session-B'
      const initialExpiry = Date.now() + 5000

      await driver.updateAccountData({
        account,
        sessions: [{ token: sessionA, expiry: initialExpiry }],
      })

      let intercepted = false
      const originalSend = driver.client.send.bind(driver.client)
      const sendSpy = vi.spyOn(driver.client, 'send').mockImplementation((async (command: unknown) => {
        const res = await originalSend(command as never)
        if (!intercepted && command instanceof GetCommand && command.input.TableName === driver.tables.accounts) {
          intercepted = true
          // Simulate concurrent changePassword revoking sessionA and keeping only sessionB
          await originalSend(new UpdateCommand({
            TableName: driver.tables.accounts,
            Key: { account },
            UpdateExpression: 'SET sessions = :sessions',
            ExpressionAttributeValues: {
              ':sessions': [
                { token: sessionB, expiry: initialExpiry + 60_000 },
              ],
            },
          }))
        }
        return res
      }) as typeof driver.client.send)

      try {
        await driver.extendSession({ account, session: sessionA })

        // sessionA must remain revoked and invalid
        await expect(
          getWithSession(account, sessionA)
        ).rejects.toThrow()

        const acctViaB = await getWithSession(account, sessionB)
        expect(acctViaB.account).toBe(account)
        expect(acctViaB.sessions?.find(s => isSessionFor(s, sessionA))).toBeUndefined()
      } finally {
        sendSpy.mockRestore()
      }
    })

    it('short-circuits retry if another concurrent extendSession already extended the session', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })

      const sessionA = 'session-A'
      const initialExpiry = Date.now() + 5000

      await driver.updateAccountData({
        account,
        sessions: [{ token: sessionA, expiry: initialExpiry }],
      })

      let intercepted = false
      let updateCalls = 0
      const originalSend = driver.client.send.bind(driver.client)
      const sendSpy = vi.spyOn(driver.client, 'send').mockImplementation((async (command: unknown) => {
        if (command instanceof UpdateCommand && command.input.TableName === driver.tables.accounts) {
          updateCalls += 1
        }
        const res = await originalSend(command as never)
        if (!intercepted && command instanceof GetCommand && command.input.TableName === driver.tables.accounts) {
          intercepted = true
          // Simulate another concurrent request for sessionA extending it first
          await originalSend(new UpdateCommand({
            TableName: driver.tables.accounts,
            Key: { account },
            UpdateExpression: 'SET sessions = :sessions',
            ExpressionAttributeValues: {
              ':sessions': [
                { token: sessionA, expiry: Date.now() + SESSION_EXPIRY_MS },
              ],
            },
          }))
        }
        return res
      }) as typeof driver.client.send)

      try {
        await driver.extendSession({ account, session: sessionA })

        // First attempt tried to Update (failed OCC), second attempt saw expiry already fresh and skipped Update
        expect(updateCalls).toBe(1)

        const acct = await getWithSession(account, sessionA)
        const recordA = acct.sessions?.find(s => isSessionFor(s, sessionA))
        expect(recordA?.expiry).toBeGreaterThan(Date.now() + 10_000)
      } finally {
        sendSpy.mockRestore()
      }
    })

    it('keeps both sessions when two logins add them concurrently', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({
        account,
        authToken: 'token',
        salt: 'salt',
        iterations: 1000,
      })
      const expiry = Date.now() + 60_000

      let intercepted = false
      const originalSend = driver.client.send.bind(driver.client)
      const sendSpy = vi.spyOn(driver.client, 'send').mockImplementation((async (command: unknown) => {
        const res = await originalSend(command as never)
        if (!intercepted && command instanceof GetCommand && command.input.TableName === driver.tables.accounts) {
          intercepted = true
          // Another login adds its session right after this one reads the sessions list
          await driver.addSession({ account, session: 'session-B', expiry })
        }
        return res
      }) as typeof driver.client.send)

      try {
        await driver.addSession({ account, session: 'session-A', expiry })
      } finally {
        sendSpy.mockRestore()
      }

      await expect(getWithSession(account, 'session-A')).resolves.toMatchObject({ account })
      await expect(getWithSession(account, 'session-B')).resolves.toMatchObject({ account })
    })
  })

  describe('Authentication errors', () => {
    it('throws AuthenticationError for an unknown account, a wrong auth token or an invalid session', async () => {
      const account = uniqueAccountId()
      await expect(login(account, 'token'))
        .rejects.toBeInstanceOf(AuthenticationError)

      await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })
      await expect(login(account, 'wrong'))
        .rejects.toBeInstanceOf(AuthenticationError)
      await expect(getWithSession(account, 'no-such-session'))
        .rejects.toBeInstanceOf(AuthenticationError)
    })
  })

  describe('Failed logins', () => {
    it('locks an account after too many failed logins, even for the right password', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })

      for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
        await driver.recordFailedLogin({ account })
      }
      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item?.failedLogins).toBe(MAX_FAILED_LOGINS)
      await expect(login(account, 'token'))
        .rejects.toBeInstanceOf(TooManyLoginAttemptsError)
    })

    it('starts a new count once the window has passed', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })
      await driver.client.send(new UpdateCommand({
        TableName: driver.tables.accounts,
        Key: { account },
        UpdateExpression: 'SET failedLogins = :count, failedLoginsSince = :since',
        ExpressionAttributeValues: { ':count': MAX_FAILED_LOGINS, ':since': Date.now() - FAILED_LOGIN_WINDOW_MS - 1000 },
      }))

      await driver.recordFailedLogin({ account })

      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item?.failedLogins).toBe(1)
      await expect(login(account, 'token'))
        .resolves.toMatchObject({ account })
    })

    it('does not create an item for an account that does not exist', async () => {
      const account = uniqueAccountId()
      await driver.recordFailedLogin({ account })

      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item).toBeUndefined()
    })
  })

  describe('Stored session tokens', () => {
    it('stores new sessions as hashes and still finds them by token', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })

      await driver.addSession({ account, session: 'session-A', expiry: Date.now() + 60_000 })

      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item?.sessions).toEqual([{ token: hashSessionToken('session-A'), expiry: expect.any(Number) }])
      await expect(getWithSession(account, 'session-A')).resolves.toMatchObject({ account })
    })

    it('accepts a session stored before hashing and rewrites it hashed when renewing it', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })
      await driver.updateAccountData({ account, sessions: [{ token: 'legacy-session', expiry: Date.now() + 60_000 }] })

      await expect(getWithSession(account, 'legacy-session')).resolves.toMatchObject({ account })
      await driver.extendSession({ account, session: 'legacy-session' })

      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item?.sessions).toEqual([{ token: hashSessionToken('legacy-session'), expiry: expect.any(Number) }])
      await expect(getWithSession(account, 'legacy-session')).resolves.toMatchObject({ account })
    })
  })

  describe('updateAccountData', () => {
    it('throws AuthenticationError for a missing account instead of creating it', async () => {
      const account = uniqueAccountId()

      await expect(driver.updateAccountData({ account, keyring: 'keyring' }))
        .rejects.toBeInstanceOf(AuthenticationError)
      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item).toBeUndefined()
    })

    it('writes app fields named after reserved words', async () => {
      const account = uniqueAccountId()
      await driver.createAccount({ account, authToken: 'token', salt: 'salt', iterations: 1000 })

      await driver.updateAccountData<{ name: string, status: string }>({ account, name: 'Flock', status: 'active' })

      const raw = await driver.client.send(new GetCommand({ TableName: driver.tables.accounts, Key: { account } }))
      expect(raw.Item).toMatchObject({ name: 'Flock', status: 'active' })
    })
  })
})
