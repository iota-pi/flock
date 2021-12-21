import { FlockPushSubscription } from '../../app/src/utils/firebase-types';
import { App, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import getDriver from '../drivers';
import { VaultSubscriptionFull } from '../drivers/base';

const driver = getDriver('dynamo');
let app: App;

function init() {
  if (!app) {
    app = initializeApp();
  }
}

function filterDueSubscriptions<T extends FlockPushSubscription>(subscriptions: T[]) {
  const results: T[] = [];
  for (const subscription of subscriptions) {
    const timeInTimezone = Intl.DateTimeFormat(
      [],
      {
        hour: 'numeric',
        hour12: false,
        minute: 'numeric',
        timeZone: subscription.timezone,
      },
    ).format();
    const hourInTimezone = parseInt(timeInTimezone.split(/\D/)[0]);
    if (subscription.hours.includes(hourInTimezone)) {
      results.push(subscription);
    }
  }
  return results;
}

function pushToSubscription(subscription: FlockPushSubscription) {
  return getMessaging().send({
    token: subscription.token,
    notification: {
      title: 'Prayer reminder',
      body: 'Let\'s pray for the flock',
      imageUrl: `${process.env.PROD_APP_URL}/flock.png`,
    },
    webpush: {
      fcmOptions: {
        link: process.env.PROD_APP_URL,
      },
    },
  });
}

function countPushError(subscription: VaultSubscriptionFull) {
  return driver.countSubscriptionFailure({ ...subscription, maxFailures: 3 });
}

export const handler = async () => {
  init();
  console.warn('About to fetch subscriptions');
  const allSubscriptions = await driver.getEverySubscription();
  console.warn(`Found ${allSubscriptions.length} subscriptions`);
  const subscriptions = filterDueSubscriptions(allSubscriptions);
  for (const subscription of subscriptions) {
    console.warn(`About to send to subscription`);
    try {
      console.log('Result:', await pushToSubscription(subscription));
    } catch (error) {
      await countPushError(subscription);
      console.error(error);
    }
  }
}
