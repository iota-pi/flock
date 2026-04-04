import { describe, expect, it } from 'vitest'
import { parseVaultEnvelope } from './envelopeParser'

describe('parseVaultEnvelope', () => {
  it('parses branching envelopes when branches are non-empty and valid', () => {
    const result = parseVaultEnvelope({
      branches: [
        {
          encryptedAutomergeDoc: 'abc',
          versionId: 'v1',
          parentIds: [],
        },
      ],
    })

    expect(result).toEqual({
      kind: 'branching',
      branches: [
        {
          encryptedAutomergeDoc: 'abc',
          versionId: 'v1',
          parentIds: [],
        },
      ],
    })
  })

  it('parses legacy envelopes when cipher and iv are present', () => {
    const result = parseVaultEnvelope({
      cipher: 'cipher',
      metadata: { iv: 'iv' },
    })

    expect(result).toEqual({
      kind: 'legacy',
      cipher: 'cipher',
      iv: 'iv',
    })
  })

  it('treats empty branches arrays as legacy-compatible when cipher exists', () => {
    const result = parseVaultEnvelope({
      cipher: 'cipher',
      metadata: { iv: 'iv' },
      branches: [],
    })

    expect(result).toEqual({
      kind: 'legacy',
      cipher: 'cipher',
      iv: 'iv',
    })
  })
})
