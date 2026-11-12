import { readSecret } from './secrets'

/** Where `Resource` from `sst` keeps the values linked to a function */
function linkedResources() {
  return (globalThis as { __SST_RESOURCE_RAW__?: Record<string, unknown> }).__SST_RESOURCE_RAW__
}

describe('readSecret', () => {
  afterEach(() => {
    delete linkedResources()?.VAPID_SUBJECT
  })

  it('returns undefined for a secret that is not linked, rather than throwing', () => {
    expect(readSecret('VAPID_SUBJECT')).toBeUndefined()
  })

  it('reads a linked secret', () => {
    readSecret('VAPID_SUBJECT')
    linkedResources()!.VAPID_SUBJECT = { type: 'sst.sst.Secret', value: 'mailto:admin@example.com' }
    expect(readSecret('VAPID_SUBJECT')).toBe('mailto:admin@example.com')
  })

  it('treats an empty secret as missing', () => {
    readSecret('VAPID_SUBJECT')
    linkedResources()!.VAPID_SUBJECT = { type: 'sst.sst.Secret', value: '' }
    expect(readSecret('VAPID_SUBJECT')).toBeUndefined()
  })
})
