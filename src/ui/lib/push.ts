// Registering for push from the browser. Everything here degrades to "not available" rather than throwing:
// iOS only offers push to an installed app, and a person who has not added it to their Home Screen should see
// a sentence explaining that, not a broken switch.
import type { PushEventKind, PushSubscription } from '../../shared/api/index.js';
import { api } from './api.js';

export type PushAvailability =
  | { available: true }
  | { available: false; reason: string };

export function pushAvailability(): PushAvailability {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { available: false, reason: 'This browser has no service worker, so it cannot receive notifications.' };
  }
  if (!('PushManager' in window)) {
    return { available: false, reason: 'This browser cannot receive push notifications. On an iPhone, add the workbench to the Home Screen and open it from there.' };
  }
  if (!window.isSecureContext) {
    return { available: false, reason: 'Notifications need a secure context. Over a tailnet, `tailscale serve` provides the TLS this needs.' };
  }
  return { available: true };
}

/** Registers the shell service worker. Safe to call repeatedly; the browser dedupes by script URL. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

/** The base64url VAPID key the browser wants as bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=').replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function subscribeToPush(deviceLabel: string, events?: PushEventKind[]): Promise<PushSubscription> {
  const registration = await registerServiceWorker();
  if (!registration) throw new Error('The service worker did not register, so this device cannot be notified.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('This browser was not given permission to show notifications.');

  const { publicKey } = await api.vapidPublicKey();
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? (await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  }));

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser produced a subscription this runtime cannot use.');
  return api.subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    deviceLabel,
    ...(events ? { events } : {}),
  });
}

/** Also tears down the browser's own subscription, so the push service stops holding an endpoint for a device that left. */
export async function unsubscribeFromPush(id: string): Promise<void> {
  await api.unsubscribePush(id);
  const registration = await navigator.serviceWorker?.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}
