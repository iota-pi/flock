import {
  ACCOUNT_ID_ALPHABET,
  describeAccountIdProblem,
  formatAccountId,
  isValidNewAccountId,
  normalizeAccountId,
} from './accountId'

describe('account IDs', () => {
  it('uses the 32 Crockford base32 characters', () => {
    expect(ACCOUNT_ID_ALPHABET).toHaveLength(32)
    expect(new Set(ACCOUNT_ID_ALPHABET).size).toBe(32)
    expect(ACCOUNT_ID_ALPHABET).not.toMatch(/[ilou]/)
  })

  describe('normalizeAccountId', () => {
    it('ignores case, spaces and hyphens', () => {
      expect(normalizeAccountId(' ABCD-1234 ')).toBe('abcd1234')
      expect(normalizeAccountId('abcd 1234')).toBe('abcd1234')
      expect(normalizeAccountId('abcd1234')).toBe('abcd1234')
    })

    it('reads I, L and O as digits in a current-length ID', () => {
      expect(normalizeAccountId('IL0O-abcd')).toBe('1100abcd')
    })

    it('leaves the letters of legacy IDs alone', () => {
      expect(normalizeAccountId('lion')).toBe('lion')
      expect(normalizeAccountId('LOUD')).toBe('loud')
    })

    it('gives UUID IDs their canonical hyphens, however they were typed', () => {
      const uuid = '0f8e2a4c-1b3d-4e5f-9a7b-6c8d0e2f4a1b'
      expect(normalizeAccountId(uuid)).toBe(uuid)
      expect(normalizeAccountId(uuid.toUpperCase())).toBe(uuid)
      expect(normalizeAccountId(uuid.replace(/-/g, ''))).toBe(uuid)
      expect(normalizeAccountId(` ${uuid.replace(/-/g, ' ')} `)).toBe(uuid)
    })
  })

  describe('isValidNewAccountId', () => {
    it('accepts 8 characters of the alphabet', () => {
      expect(isValidNewAccountId('abcd1234')).toBe(true)
      expect(isValidNewAccountId('zzzzzzzz')).toBe(true)
    })

    it('rejects other lengths, separators and characters outside the alphabet', () => {
      expect(isValidNewAccountId('abcd123')).toBe(false)
      expect(isValidNewAccountId('abcd-1234')).toBe(false)
      expect(isValidNewAccountId('abcd123u')).toBe(false)
      expect(isValidNewAccountId('ABCD1234')).toBe(false)
    })
  })

  describe('describeAccountIdProblem', () => {
    it('accepts current and legacy IDs in any case or spacing', () => {
      expect(describeAccountIdProblem('ABCD-1234')).toBeNull()
      expect(describeAccountIdProblem('lion')).toBeNull()
      expect(describeAccountIdProblem('ab12')).toBeNull()
      expect(describeAccountIdProblem('0f8e2a4c-1b3d-4e5f-9a7b-6c8d0e2f4a1b')).toBeNull()
      expect(describeAccountIdProblem('0F8E2A4C1B3D4E5F9A7B6C8D0E2F4A1B')).toBeNull()
    })

    it('rejects UUID-length IDs that are not hex', () => {
      expect(describeAccountIdProblem('0f8e2a4c-1b3d-4e5f-9a7b-6c8d0e2f4a1z')).not.toBeNull()
    })

    it('explains IDs of the wrong length', () => {
      expect(describeAccountIdProblem('abcd-123')).toMatch(/8 characters/)
      expect(describeAccountIdProblem('abc')).toMatch(/8 characters/)
    })

    it('explains characters outside the alphabet', () => {
      expect(describeAccountIdProblem('abcd-123u')).toMatch(/without U/)
      expect(describeAccountIdProblem('abcd_123')).toMatch(/without U/)
    })
  })

  describe('formatAccountId', () => {
    it('splits current IDs in half', () => {
      expect(formatAccountId('abcd1234')).toBe('abcd-1234')
    })

    it('shows legacy and unrecognised IDs as they are', () => {
      expect(formatAccountId('ab12')).toBe('ab12')
      expect(formatAccountId('0f8e2a4c-1b3d-4e5f-9a7b-6c8d0e2f4a1b')).toBe('0f8e2a4c-1b3d-4e5f-9a7b-6c8d0e2f4a1b')
      expect(formatAccountId('')).toBe('')
    })
  })
})
