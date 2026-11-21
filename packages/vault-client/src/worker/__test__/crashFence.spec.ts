import type { Keyring } from '../../keys/Keyring'
import { FakeVaultServer } from './FakeVaultServer'
import { createAccountKeys, Device, installLocalStorage } from './syncLogHarness'

describe('a device crash', () => {
  let server: FakeVaultServer
  let keys: Keyring
  const devices: Device[] = []

  async function startDevice(name: string): Promise<Device> {
    const device = new Device(name, server, keys)
    devices.push(device)
    return device.start()
  }

  beforeEach(async () => {
    installLocalStorage()
    server = new FakeVaultServer()
    keys = await createAccountKeys()
  })

  afterEach(async () => {
    await Promise.all(devices.splice(0).map(device => device.context.session.isShutdown ? null : device.stop()))
  })

  it('loses an edit the device had not stored', async () => {
    const a = await startDevice('device-a')
    const itemId = await a.create('item-1', { title: 'one' })
    await a.flushDocs([itemId])

    await a.edit(itemId, { title: 'two' })
    await a.crash()
    await a.start()

    expect((await a.read(itemId))?.title).toBe('one')
  })

  it('keeps an edit the device had stored', async () => {
    const a = await startDevice('device-a')
    const itemId = await a.create('item-1', { title: 'one' })
    await a.edit(itemId, { title: 'two' })
    await a.flushDocs([itemId])

    await a.crash()
    await a.start()

    expect((await a.read(itemId))?.title).toBe('two')
  })

  it('loses a cursor the device had not saved yet', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    await a.create('item-1', { title: 'one' })
    await a.poll()

    await b.poll()
    expect(b.services.puller.cursor).toBe(1)
    await b.crash()
    await b.start()

    expect(b.services.puller.cursor).toBe(0)
  })

  it('leaves the storage of other devices alone', async () => {
    const a = await startDevice('device-a')
    const b = await startDevice('device-b')
    const itemId = await b.create('item-1', { title: 'one' })

    const crash = a.crash()
    await b.edit(itemId, { title: 'two' })
    await b.flushDocs([itemId])
    await crash
    await b.restart()

    expect((await b.read(itemId))?.title).toBe('two')
  })
})
