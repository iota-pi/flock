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

function pushToSubscriptions(subscriptions: FlockPushSubscription[]) {
  const promises = [];
  for (let i = 0; i < subscriptions.length; i += 100) {
    const subscriptionsSlice = subscriptions.slice(i, i + 100);
    const tokens = subscriptionsSlice.map(subscription => subscription.token);
    promises.push(
      getMessaging().sendMulticast({
        tokens,
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
      }),
    );
  }
  return Promise.all(promises);
}

function countPushError(subscription: VaultSubscriptionFull) {
  return driver.countSubscriptionFailure({ ...subscription, maxFailures: 3 });
}

export const handler = async () => {
  init();
  const allSubscriptions = await driver.getEverySubscription();
  console.log(`Found ${allSubscriptions.length} subscriptions`);
  const subscriptions = filterDueSubscriptions(allSubscriptions);
  const responseSets = await pushToSubscriptions(subscriptions);
  let totalFailures = 0;
  let index = 0;
  for (const responseSet of responseSets) {
    if (responseSet.failureCount > 0) {
      for (const response of responseSet.responses) {
        if (!response.success) {
          await countPushError(subscriptions[index]);
          ++totalFailures;
        }
        ++index;
      }
    } else {
      index += responseSet.successCount;
    }
  }
  console.log(
    `Sent notifications to ${subscriptions.length} devices (${totalFailures} failures)`,
  );
}
