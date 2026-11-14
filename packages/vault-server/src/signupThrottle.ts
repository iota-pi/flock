import { createHmac } from 'crypto'
import { isIPv4, isIPv6 } from 'net'

/**
 * Accounts one network may create within a window before further sign-ups are refused until the
 * next one. Generous, since a whole church can sign up together on one Wi-Fi network, and mobile
 * carriers put many phones behind one IPv4 address. It only stops one source creating accounts in
 * bulk cheaply, not a botnet.
 */
export const MAX_SIGNUPS_PER_WINDOW = 50
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000

/**
 * Settings for counting sign-ups per network. The throttle table only holds HMACs of the network,
 * keyed by `secret` and the window, so it never stores an IP address, and rows from different
 * windows can't be linked to each other even by someone who has the secret.
 */
export interface SignupThrottleOptions {
  /** Keys the HMAC. Changing it only resets the current window's counts. */
  secret: string
}

/** One window's count of sign-ups from a network */
export interface SignupReservation {
  /** The throttle row's key */
  key: string
  /** When the window ends, in ms */
  windowEnd: number
}

/** Expands a valid IPv6 address into its eight 16-bit groups */
function ipv6Groups(address: string): number[] {
  // Rewrite an embedded IPv4 tail (as in ::ffff:192.0.2.1) as the two groups it stands for
  const text = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a, b, c, d) => (
    `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`
  ))
  const parse = (part: string) => (part ? part.split(':').map(group => parseInt(group, 16)) : [])
  const [head, rest] = text.split('::')
  const headGroups = parse(head)
  if (rest === undefined) return headGroups
  const restGroups = parse(rest)
  const zeros = new Array<number>(8 - headGroups.length - restGroups.length).fill(0)
  return [...headGroups, ...zeros, ...restGroups]
}

/**
 * The network a client address belongs to, for counting sign-ups: an IPv4 address on its own, or an
 * IPv6 address's /64, which is what one home or phone is usually given. IPv4-mapped IPv6 addresses
 * count as their IPv4 address. Returns undefined when the address isn't an IP address.
 */
export function signupNetwork(address: string | undefined): string | undefined {
  if (!address) return undefined
  // Drop any zone index (fe80::1%eth0)
  const ip = address.split('%')[0]
  if (isIPv4(ip)) return ip
  if (!isIPv6(ip)) return undefined
  const groups = ipv6Groups(ip)
  const isMappedIpv4 = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff
  if (isMappedIpv4) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
}

/**
 * The throttle row for sign-ups from a client address in the window `now` falls in, or undefined
 * when the address isn't an IP address. The window's index is part of the HMAC input, so each
 * window's rows are unlinkable to the last's.
 */
export function signupReservation(
  { secret }: SignupThrottleOptions,
  address: string | undefined,
  now: number,
): SignupReservation | undefined {
  const network = signupNetwork(address)
  if (!network) return undefined
  const window = Math.floor(now / SIGNUP_WINDOW_MS)
  const hmac = createHmac('sha256', secret).update(`${window}|${network}`).digest('base64url')
  // `#` keeps these apart from login rows, whose keys are bare base64url
  return { key: `signup#${hmac}`, windowEnd: (window + 1) * SIGNUP_WINDOW_MS }
}
