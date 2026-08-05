import { sendPushNotification } from './webpush'
import * as webPush from 'web-push'

vi.mock('web-push', () => ({
  sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
  setVapidDetails: vi.fn(),
}))

describe('webpush service', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('throws error if VAPID environment variables are missing', async () => {
    delete process.env.VAPID_SUBJECT
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY

    const subscription = {
      endpoint: 'https://push.example.com/sub1',
      keys: { auth: 'auth1', p256dh: 'p256dh1' },
    }
    const payload = { title: 'Test', body: 'Body' }

    await expect(sendPushNotification(subscription, payload)).rejects.toThrow(
      'Missing VAPID_SUBJECT, VAPID_PUBLIC_KEY, or VAPID_PRIVATE_KEY',
    )
  })

  it('calls setVapidDetails and sendNotification when configured', async () => {
    process.env.VAPID_SUBJECT = 'mailto:admin@example.com'
    process.env.VAPID_PUBLIC_KEY = 'pubkey'
    process.env.VAPID_PRIVATE_KEY = 'privkey'

    const subscription = {
      endpoint: 'https://push.example.com/sub2',
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
    )
  })
})
