import { z } from 'zod'
import { FlockAccountFieldsSchema, WebPushSubscriptionSchema } from '../shared/schemas/notifications'

export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>

/** Fields Flock stores on vault account records (see FlockAccountFieldsSchema) */
export type FlockAccountFields = z.infer<typeof FlockAccountFieldsSchema>
