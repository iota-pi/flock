/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */

import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
import firebaseConfig from './utils/firebase-config';

declare const self: ServiceWorkerGlobalScope;

function initServiceWorker() {
  const app = initializeApp(firebaseConfig);
  const messaging = getMessaging(app);
  onBackgroundMessage(messaging, async () => {
    console.log('Sent notification');
  });
}

initServiceWorker();

// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ignored = self.__WB_MANIFEST;
