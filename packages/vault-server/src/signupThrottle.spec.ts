import { SIGNUP_WINDOW_MS, signupNetwork, signupReservation } from './signupThrottle'

const OPTIONS = { secret: 'test-secret' }
const NOW = 1_800_000_000_000

describe('signupNetwork', () => {
  it.each([
    ['an IPv4 address', '192.0.2.1', '192.0.2.1'],
    ['a full IPv6 address', '2001:0db8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::/64'],
    ['a compressed IPv6 address', '2001:db8::1', '2001:db8:0:0::/64'],
    ['an IPv6 address compressed within its /64', '2001:db8::5:6:7:8', '2001:db8:0:0::/64'],
    ['an IPv6 address with a zone index', 'fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['an IPv4-mapped IPv6 address', '::ffff:192.0.2.1', '192.0.2.1'],
    ['an IPv4-mapped IPv6 address in hex', '::ffff:c000:201', '192.0.2.1'],
    ['an IPv6 address with an IPv4 tail', '64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
    ['the IPv6 loopback', '::1', '0:0:0:0::/64'],
  ])('reduces %s to its network', (_case, address, network) => {
    expect(signupNetwork(address)).toBe(network)
  })

  it('puts addresses in the same /64 together and other /64s apart', () => {
    expect(signupNetwork('2001:db8:1:2:aaaa::1')).toBe(signupNetwork('2001:db8:1:2:bbbb::2'))
    expect(signupNetwork('2001:db8:1:2::1')).not.toBe(signupNetwork('2001:db8:1:3::1'))
  })

  it.each([undefined, '', 'localhost', '300.1.2.3', 'not:an:address'])('returns undefined for %j', address => {
    expect(signupNetwork(address)).toBeUndefined()
  })
})

describe('signupReservation', () => {
  it('keys a network the same way throughout a window, ending with it', () => {
    const windowStart = Math.floor(NOW / SIGNUP_WINDOW_MS) * SIGNUP_WINDOW_MS
    const first = signupReservation(OPTIONS, '2001:db8::1', windowStart)
    const last = signupReservation(OPTIONS, '2001:db8::2', windowStart + SIGNUP_WINDOW_MS - 1)
    expect(first).toEqual(last)
    expect(first?.windowEnd).toBe(windowStart + SIGNUP_WINDOW_MS)
  })

  it('gives each window, network and secret its own key, holding no address', () => {
    const reservation = signupReservation(OPTIONS, '192.0.2.1', NOW)
    expect(reservation?.key).toMatch(/^signup#[A-Za-z0-9_-]{43}$/)
    expect(reservation?.key).not.toContain('192')

    const keys = new Set([
      reservation?.key,
      signupReservation(OPTIONS, '192.0.2.1', NOW + SIGNUP_WINDOW_MS)?.key,
      signupReservation(OPTIONS, '192.0.2.2', NOW)?.key,
      signupReservation({ secret: 'other-secret' }, '192.0.2.1', NOW)?.key,
    ])
    expect(keys.size).toBe(4)
  })

  it('returns undefined for a client address that is not an IP address', () => {
    expect(signupReservation(OPTIONS, undefined, NOW)).toBeUndefined()
  })
})
