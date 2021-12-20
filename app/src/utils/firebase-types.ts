import { FirebaseOptions } from 'firebase/app';

export interface FlockPushSubscription {
  failures: number,
  hours: number[],
  timezone: string,
  token: string,
}
