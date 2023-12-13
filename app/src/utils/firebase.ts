import { initializeApp } from 'firebase/app';
import { getMessaging, getToken as firebaseGetToken } from 'firebase/messaging';
import Vault from '../api/Vault';
import env from '../env';
import firebaseConfig from './firebase-config';

export const app = initializeApp(firebaseConfig);

async function getToken() {
  const messaging = getMessaging();
  return firebaseGetToken(
    messaging,
    {
      vapidKey: env.VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.getRegistration(),
    },
  );
}

export async function subscribe(vault: Vault, hours: number[]) {
  const token = await getToken();
  await vault.setSubscription({
    failures: 0,
    hours,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    token,
  });
}

export async function unsubscribe(vault: Vault) {
  const token = await getToken();
  await vault.deleteSubscription(token);
}

export async function checkSubscription(vault: Vault) {
  const authorized = Notification.permission === 'granted';
  if (!authorized) {
    return null;
  }
  const token = await getToken();
  const existing = await vault.getSubscription(token);
  return existing;
}
