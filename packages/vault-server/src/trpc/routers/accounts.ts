import { randomBytes } from 'crypto'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure, protectedProcedure } from '../trpc'
import {
  AccountInputSchema,
  CreateAccountBodySchema,
  LoginBodySchema,
  LogoutBodySchema,
  UpdateKeyringBodySchema,
  ChangePasswordBodySchema,
  DeleteAccountBodySchema,
  TOO_MANY_REQUESTS_MESSAGE,
  VersionConflictError,
} from '@vault/shared'
import { fakeSalt, generateAccountId, hashString } from '../../util'
import { addSessionRecord, findSession, SESSION_EXPIRY_MS } from '../../sessions'
import { raiseDataVersion } from '../../services/dataVersion'
import { AuthenticationError, TooManyLoginAttemptsError } from '../../errors'
import { authenticateLogin, matchesAuthTokenHash } from '../../authentication'
import { isLoginDevice } from '../../loginDevices'
import { toTrpcError } from '../errors'
import type { StoredAccount, VaultAccountWithAuth, VaultDriver } from '../../drivers/vaultDriver'
import type { KdfParams } from '@vault/shared'
import type { UnknownAccountParams } from '../trpc'
import { signupReservation, type SignupThrottleOptions } from '../../signupThrottle'
import type { DataVersionPolicy } from '../../services/dataVersion'

// Each attempt is a single conditional write, and a collision between random IDs is very unlikely
const MAX_CREATE_ACCOUNT_ATTEMPTS = 10

// The most rows one `deleteItems` call deletes from each table
const DELETE_BATCH_LIMIT = 500

/** What a client needs to derive an account's master key, plus its data version */
interface SecurityParams {
  salt: string,
  iterations?: number,
  saltVersion?: number,
  kdf?: KdfParams,
  dataVersion?: number,
}

/** Credential changes need the current password as well as the session */
function assertCurrentAuthToken(accountData: VaultAccountWithAuth, currentAuthToken: string): void {
  if (!matchesAuthTokenHash(accountData, hashString(currentAuthToken))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Incorrect current password' })
  }
}

function accountSecurityParams(record: StoredAccount): SecurityParams {
  return {
    // Accounts from before per-account salts used the account ID as the salt
    salt: typeof record.salt === 'string' ? record.salt : record.account,
    iterations: record.iterations,
    saltVersion: record.saltVersion,
    kdf: record.kdf,
    dataVersion: record.dataVersion,
  }
}

/**
 * Builds `getSecurityParams`'s response field by field in a fixed order, so that a real account
 * and a made-up one can't be told apart by which fields are set or the order of their keys (a
 * stored `kdf` map comes back from DynamoDB in its own key order). `iterations` is left out once
 * the account has Argon2id parameters, since clients ignore it then and only migrated PBKDF2
 * accounts would still have it.
 */
function securityParamsResponse(params: SecurityParams) {
  const { salt, iterations, saltVersion, kdf, dataVersion } = params
  return {
    success: true,
    salt,
    ...(!kdf && iterations !== undefined ? { iterations } : {}),
    ...(saltVersion !== undefined ? { saltVersion } : {}),
    ...(kdf
      ? {
        kdf: {
          algorithm: kdf.algorithm,
          memoryKiB: kdf.memoryKiB,
          passes: kdf.passes,
          parallelism: kdf.parallelism,
        } satisfies KdfParams,
      }
      : {}),
    // Returned before login, so that the app can route accounts that need migrating
    dataVersion: dataVersion ?? 0,
  }
}

/**
 * Made-up security parameters for an account that doesn't exist. They look like an account that has
 * nothing to migrate, so that logging in fails as for a wrong password.
 */
function unknownAccountSecurityParams(
  account: string,
  fake: UnknownAccountParams,
  dataVersionPolicy?: DataVersionPolicy,
): SecurityParams {
  return {
    salt: fakeSalt(account, fake.secret),
    iterations: fake.iterations,
    saltVersion: fake.saltVersion,
    kdf: fake.kdf,
    dataVersion: dataVersionPolicy?.current,
  }
}

/**
 * Counts a sign-up against the client's network, refusing it as TOO_MANY_REQUESTS once the network
 * has used up the window's sign-ups. Every attempt counts, since creating an account rarely fails.
 * Does nothing without `signupThrottle`, or for a client address that isn't an IP address.
 */
async function reserveSignup(
  { vault, signupThrottle, clientAddress }: {
    vault: VaultDriver,
    signupThrottle?: SignupThrottleOptions,
    clientAddress?: string,
  },
): Promise<void> {
  if (!signupThrottle) return
  const reservation = signupReservation(signupThrottle, clientAddress, Date.now())
  if (!reservation) {
    console.warn('Not limiting a sign-up with no client IP address')
    return
  }
  if (!await vault.reserveSignup(reservation)) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS_MESSAGE })
  }
}

export const accountsRouter = router({
  createAccount: publicProcedure
    .input(CreateAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      await reserveSignup(ctx)
      for (let attempt = 0; attempt < MAX_CREATE_ACCOUNT_ATTEMPTS; attempt += 1) {
        const account = generateAccountId()
        // Returns false if the ID is already taken, in which case we try another one
        const created = await ctx.vault.createAccount({
          account,
          authToken: hashString(input.authToken),
          salt: input.salt,
          saltVersion: input.saltVersion,
          kdf: input.kdf,
          keyring: input.keyring,
          randomDataKeys: input.randomDataKeys,
          keyringVersion: input.keyringVersion,
        })
        if (created) {
          return { account }
        }
      }

      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create account' })
    }),

  login: publicProcedure
    .input(LoginBodySchema)
    .mutation(async ({ ctx, input }) => {
      // Count the attempt before checking the password, and in the same write as the lock check, so
      // that concurrent guesses can't all get past the lock. Do both whether or not the account
      // exists, so that unknown IDs take the same path.
      const [record, reservation] = await Promise.all([
        ctx.vault.getAccountRecord({ account: input.account }),
        ctx.vault.reserveLoginAttempt({ account: input.account }),
      ])
      const authTokenHash = hashString(input.authToken)
      const deviceHash = input.deviceToken === undefined ? undefined : hashString(input.deviceToken)
      try {
        authenticateLogin(record, reservation === undefined, { authTokenHash, deviceHash })
      } catch (error) {
        // Failing to forget the device mustn't turn a wrong password into a server error.
        // The app sends its device token only with a password that opened the token locally, so a
        // login device with the wrong password means someone else has the token
        if (deviceHash && record && isLoginDevice(record, deviceHash) && !matchesAuthTokenHash(record, authTokenHash)) {
          await ctx.vault.removeLoginDevice({ account: input.account, device: deviceHash }).catch(removeError => {
            console.warn('[accounts.login] Could not forget a login device:', removeError)
          })
        }
        throw toTrpcError(error, [
          { error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS_MESSAGE },
          { error: AuthenticationError, code: 'UNAUTHORIZED' },
        ])
      }

      // A right password doesn't count towards the lock. Failing to uncount it only costs an attempt.
      // A login device let through a lock has nothing to uncount.
      if (reservation) {
        await ctx.vault.releaseLoginAttempt({ account: input.account, ...reservation }).catch(releaseError => {
          console.warn('[accounts.login] Could not uncount a successful login:', releaseError)
        })
      }

      // The driver adds it with a conditional write, so concurrent logins don't drop each other's
      // sessions or devices
      const session = randomBytes(16).toString('base64')
      await ctx.vault.addSession({
        account: input.account,
        session,
        expiry: Date.now() + SESSION_EXPIRY_MS,
        ...(deviceHash === undefined ? {} : { device: deviceHash }),
      })

      return {
        success: true,
        session,
      }
    }),

  // Clients call this when they lock or forget the account. Holding the token is the proof, so it
  // needs no other session, and it answers the same whether or not the token or account exists. Not a
  // protected procedure, which would renew the session it is ending.
  logout: publicProcedure
    .input(LogoutBodySchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.removeSession({ account: input.account, session: input.session })
      return { success: true }
    }),

  getSecurityParams: publicProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const record = await ctx.vault.getAccountRecord({ account: input.account })
      let params: SecurityParams
      if (record) {
        params = accountSecurityParams(record)
      } else if (ctx.unknownAccountParams) {
        params = unknownAccountSecurityParams(input.account, ctx.unknownAccountParams, ctx.dataVersionPolicy)
      } else {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
      }

      return securityParamsResponse(params)
    }),

  // Clients call this once their migrations have run. Returns why it couldn't be raised, if it couldn't.
  raiseDataVersion: protectedProcedure
    .mutation(async ({ ctx, input }) => {
      const result = await raiseDataVersion(ctx.vault, {
        account: input.account,
        accountData: ctx.accountData,
        policy: ctx.dataVersionPolicy,
      })
      return { success: true, ...result }
    }),

  getKeyring: protectedProcedure
    .query(async ({ ctx }) => {
      return {
        success: true,
        keyring: ctx.accountData.keyring,
        // Only builds from before new accounts started at key version 2 read this
        randomDataKeys: ctx.accountData.randomDataKeys === true,
      }
    }),

  updateKeyring: protectedProcedure
    .input(UpdateKeyringBodySchema)
    .mutation(async ({ ctx, input }) => {
      assertCurrentAuthToken(ctx.accountData, input.currentAuthToken)

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          keyring: input.keyring,
          keyringVersion: input.keyringVersion,
          expectedKeyringVersion: input.expectedKeyringVersion,
        })
      } catch (error) {
        throw toTrpcError(error, [
          { error: VersionConflictError, code: 'CONFLICT', message: 'Concurrent key rotation detected: keyringVersion conflict' },
        ])
      }

      return { success: true }
    }),

  changePassword: protectedProcedure
    .input(ChangePasswordBodySchema)
    .mutation(async ({ ctx, input }) => {
      assertCurrentAuthToken(ctx.accountData, input.currentAuthToken)

      const newAuthTokenHash = hashString(input.newAuthToken)

      // Changing the password ends every other session and forgets every login device. This device
      // registers again at its next login.
      const currentSessionExpiry = findSession(ctx.accountData.sessions, ctx.authToken)?.expiry
        ?? Date.now() + SESSION_EXPIRY_MS

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          authToken: newAuthTokenHash,
          salt: input.newSalt,
          kdf: input.newKdf,
          keyring: input.newKeyring,
          saltVersion: input.saltVersion,
          keyringVersion: input.keyringVersion,
          expectedKeyringVersion: input.expectedKeyringVersion,
          sessions: addSessionRecord([], ctx.authToken, currentSessionExpiry),
          loginDevices: [],
          // The new password always uses Argon2id, so a migrated PBKDF2 account's iteration count
          // is stale, and keeping it would set the account apart from others
          remove: ['iterations'],
        })
      } catch (error) {
        throw toTrpcError(error, [
          { error: VersionConflictError, code: 'CONFLICT', message: 'Concurrent credential update detected: keyringVersion conflict' },
        ])
      }

      return { success: true }
    }),

  /**
   * The first step of deleting an account: deletes a round of its items, then of its log rows, and
   * reports whether any are left, so the client calls it until they're gone. Each call stays well
   * within the Lambda's timeout, however much data the account has.
   *
   * It hard-deletes, which is safe only because the account is going: it first marks the account as
   * being deleted, which stops it logging in, and ends every other session and forgets every login
   * device, so no other device can sync the missing items back up.
   */
  deleteItems: protectedProcedure
    .input(DeleteAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      assertCurrentAuthToken(ctx.accountData, input.currentAuthToken)

      const currentSessionExpiry = findSession(ctx.accountData.sessions, ctx.authToken)?.expiry
        ?? Date.now() + SESSION_EXPIRY_MS
      await ctx.vault.updateAccountData({
        account: input.account,
        sessions: addSessionRecord([], ctx.authToken, currentSessionExpiry),
        loginDevices: [],
        deletingSince: ctx.accountData.deletingSince ?? Date.now(),
      })

      const items = await ctx.vault.deleteItems({ account: input.account, limit: DELETE_BATCH_LIMIT })
      if (!items.done) {
        return { success: true, done: false }
      }
      const log = await ctx.vault.deleteSyncLog({ account: input.account, limit: DELETE_BATCH_LIMIT })
      return { success: true, done: log.done }
    }),

  /**
   * The second step of deleting an account: deletes its record, which ends every session and stops its
   * reminders. Clients call it after `deleteItems`, whose rows would be left with no way to delete them.
   */
  deleteAccount: protectedProcedure
    .input(DeleteAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      assertCurrentAuthToken(ctx.accountData, input.currentAuthToken)
      await ctx.vault.deleteAccount({ account: input.account })
      return { success: true }
    }),
})