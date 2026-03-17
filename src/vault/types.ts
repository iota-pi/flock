export type ItemType = 'person' | 'group' | 'topic'

export type WebPushSubscription = {
  endpoint: string,
  keys: {
    p256dh: string,
    auth: string,
  },
}