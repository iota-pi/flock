import { MAX_LOGIN_DEVICES } from '@vault/shared'
import type { StoredAccount } from './drivers/vaultDriver'

/*
 * An account's login devices are hashes of the device tokens it has seen with the right password,
 * earliest first. A login from one of them with the right password isn't held up by the failed-login
 * lock (see authentication.ts).
 *
 * Only the list is kept, with no dates, so the server doesn't learn when each device was last used.
 * Registering a device past MAX_LOGIN_DEVICES forgets the earliest even if it's still in use; that
 * device is registered again at its next login that gets through.
 */

export function normalizeLoginDevices(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((device): device is string => typeof device === 'string') : []
}

export function isLoginDevice(record: Pick<StoredAccount, 'loginDevices'>, deviceHash: string | undefined): boolean {
  return deviceHash !== undefined && normalizeLoginDevices(record.loginDevices).includes(deviceHash)
}

/** The devices with `deviceHash` added at the end, or undefined when it's there already */
export function withLoginDevice(devices: string[], deviceHash: string): string[] | undefined {
  if (devices.includes(deviceHash)) return undefined
  return [...devices, deviceHash].slice(-MAX_LOGIN_DEVICES)
}

/** The devices without `deviceHash`, or undefined when it isn't there */
export function withoutLoginDevice(devices: string[], deviceHash: string): string[] | undefined {
  if (!devices.includes(deviceHash)) return undefined
  return devices.filter(device => device !== deviceHash)
}
