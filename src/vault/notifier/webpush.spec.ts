import { sendPushNotification } from './webpush'
import * as webPush from 'web-push'
import * as secrets from '../secrets'
import { spyOnExports } from '../../utils/testUtils'

const VAPID_SECRETS: Partial<Record<secrets.SecretName, string>> = {
  VAPID_SUBJECT: 'mailto:admin@example.com',
  VAPID_PUBLIC_KEY: 'pubkey',
  VAPID_PRIVATE_KEY: 'privkey',
}

function linkSecrets(values: Partial<Record<secrets.SecretName, string>>) {
  vi.spyOn(secrets, 'readSecret').mockImplementation(name => values[name])
}

beforeEach(() => {
  spyOnExports(webPush, {
    sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
    setVapidDetails: vi.fn(),
  })
})

describe('webpush service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws error if VAPID environment variables are missing', async () => {
    linkSecrets({})

    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub1',
      keys: { auth: 'auth1', p256dh: 'p256dh1' },
    }
    const payload = { title: 'Test', body: 'Body' }

    await expect(sendPushNotification(subscription, payload)).rejects.toThrow(
      'Missing VAPID_SUBJECT, VAPID_PUBLIC_KEY, or VAPID_PRIVATE_KEY',
    )
  })

  it('calls setVapidDetails and sendNotification when configured', async () => {
    linkSecrets(VAPID_SECRETS)

    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub2',
      keys: { auth: 'auth2', p256dh: 'p256dh2' },
    }
    const payload = { title: 'Prayer reminder', body: 'Time to pray for your flock.' }

    await sendPushNotification(subscription, payload)

    expect(webPush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:admin@example.com',
      'pubkey',
      'privkey',
    )
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify(payload),
      { timeout: 10_000, topic: undefined, TTL: undefined },
    )
  })

  it('passes the topic and TTL through to sendNotification', async () => {
    linkSecrets(VAPID_SECRETS)

    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub3',
      keys: { auth: 'auth3', p256dh: 'p256dh3' },
    }
    const payload = { title: 'Prayer reminder', body: 'Time to pray for your flock.' }

    await sendPushNotification(subscription, payload, { topic: 'reminder-2026-10-17', ttl: 3600 })

    expect(webPush.sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify(payload),
      { timeout: 10_000, topic: 'reminder-2026-10-17', TTL: 3600 },
    )
  })

  it('refuses to send to an endpoint that is not a known push service', async () => {
    linkSecrets(VAPID_SECRETS)

    const subscription = {
      endpoint: 'https://attacker.example.com/sub',
      keys: { auth: 'auth4', p256dh: 'p256dh4' },
    }

    await expect(sendPushNotification(subscription, { title: 'T', body: 'B' })).rejects.toThrow('not a known push service')
    expect(webPush.sendNotification).not.toHaveBeenCalled()
  })
})
