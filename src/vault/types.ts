import { z } from 'zod'
import { WebPushSubscriptionSchema } from '../shared/schemas/vault'

export type ItemType = 'person' | 'group' | 'topic'

export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>

