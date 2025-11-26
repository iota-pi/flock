/// <reference lib="webworker" />

import { initializeApp } from 'firebase/app'
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw'
import firebaseConfig from './utils/firebase-config'

declare const self: ServiceWorkerGlobalScope

function initServiceWorker() {
  const app = initializeApp(firebaseConfig)
  const messaging = getMessaging(app)
  onBackgroundMessage(messaging, async () => {
    console.info('Sent notification')
  })
}

initServiceWorker()

// @ts-expect-error - This is a hack to make Webpack include the manifest
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ignored = self.__WB_MANIFEST
