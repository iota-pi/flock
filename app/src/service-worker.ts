/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */

import { initializeApp } from 'firebase/app';
import firebaseConfig from './utils/firebase-config';

declare const self: ServiceWorkerGlobalScope;

function initServiceWorker() {
  initializeApp(firebaseConfig);
}

initServiceWorker();

// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ignored = self.__WB_MANIFEST;
