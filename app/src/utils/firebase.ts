import { initializeApp } from 'firebase/app';
import { getMessaging, getToken } from 'firebase/messaging';
import Vault from '../crypto/Vault';
import firebaseConfig from './firebase-config';

export const app = initializeApp(firebaseConfig);

export async function subscribe(vault: Vault) {
  const messaging = getMessaging();
  const token = await getToken(
    messaging,
    {
      vapidKey: process.env.REACT_APP_VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.getRegistration(),
    },
  );
  console.warn(`Received token: ${token}`);
  await vault.setSubscription({
    failures: 0,
    hours: [9],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    token,
  });
}
