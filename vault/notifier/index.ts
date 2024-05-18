import { FlockPushSubscription } from '../../app/src/utils/firebase-types'
// eslint-disable-next-line import/no-unresolved
import { App, initializeApp } from 'firebase-admin/app'
// eslint-disable-next-line import/no-unresolved
import { getMessaging } from 'firebase-admin/messaging'
import getDriver from '../drivers'
import { VaultSubscriptionFull } from '../drivers/base'

const driver = getDriver('dynamo')
let app: App

function init() {
  if (!app) {
    app = initializeApp()
  }
}

function filterDueSubscriptions<T extends FlockPushSubscription>(subscriptions: T[]) {
  const results: T[] = []
  for (const subscription of subscriptions) {
    const timeInTimezone = Intl.DateTimeFormat(
      [],
      {
        hour: 'numeric',
        hour12: false,
        minute: 'numeric',
        timeZone: subscription.timezone,
      },
    ).format()
    const hourInTimezone = parseInt(timeInTimezone.split(/\D/)[0])
    if (subscription.hours.includes(hourInTimezone)) {
      results.push(subscription)
    }
  }
  return results
}

function getMessageBody() {
  const options = [
    'Let\'s pray for the flock!',
    'Time to pray for the flock',
    'Come in humble prayer to God Almighty',
    'We depend on God in everything 🙏',
    'To God be the glory!',
    'Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God.\nPhilippians 4:6 (NIV)',
    'Devote yourselves to prayer, being watchful and thankful.\nColossians 4:2 (NIV)',
  ]
  return options[Math.floor(Math.random() * options.length)]
}

function pushToSubscriptions(subscriptions: FlockPushSubscription[]) {
  const promises = []
  for (let i = 0; i < subscriptions.length; i += 100) {
    const subscriptionsSlice = subscriptions.slice(i, i + 100)
    const tokens = subscriptionsSlice.map(subscription => subscription.token)
    promises.push(
      getMessaging().sendMulticast({
        tokens,
        notification: {
          title: 'Prayer reminder',
          body: getMessageBody(),
        },
        webpush: {
          fcmOptions: {
            link: process.env.PROD_APP_URL,
          },
          notification: {
            icon: `${process.env.PROD_APP_URL}/flock.png`,
          },
        },
      }),
    )
  }
  return Promise.all(promises)
}

function countPushError(subscription: VaultSubscriptionFull) {
  return driver.countSubscriptionFailure({ ...subscription, maxFailures: 3 })
}

export const handler = async () => {
  init()
  const allSubscriptions = await driver.getEverySubscription()
  console.info(`Found ${allSubscriptions.length} subscriptions`)
  const subscriptions = filterDueSubscriptions(allSubscriptions)
  const responseSets = await pushToSubscriptions(subscriptions)
  let totalFailures = 0
  let index = 0
  for (const responseSet of responseSets) {
    if (responseSet.failureCount > 0) {
      for (const response of responseSet.responses) {
        if (!response.success) {
          await countPushError(subscriptions[index])
          totalFailures += 1
        }
        index += 1
      }
    } else {
      index += responseSet.successCount
    }
  }
  console.info(
    `Sent notifications to ${subscriptions.length} devices (${totalFailures} failures)`,
  )
}
