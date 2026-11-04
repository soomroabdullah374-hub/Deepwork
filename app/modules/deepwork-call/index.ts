// Reminder calls (Android, see android/): exact alarms that ring the phone like an
// incoming call, a ringing screen over the lock screen, and Answer opening the app's call
// screen at deepwork://call/<session id>. No phone number is involved and nothing leaves
// the phone. Elsewhere (iOS, web) every function does nothing.

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface CallSpec {
  /** The session the call is about. */
  id: string;
  /** When it rings, epoch ms. */
  at: number;
  /** Caller name on the ringing screen. */
  title: string;
  body: string;
}

interface NativeCalls {
  schedule(calls: CallSpec[]): void;
  cancel(id: string): void;
  ringIn(seconds: number, call: Omit<CallSpec, 'at'>): void;
  stopRinging(id: string): void;
  canRingFullScreen(): boolean;
  openFullScreenSettings(): void;
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeCalls>('DeepworkCall') : null;

/** This build can ring (Android with the native module). */
export const callsAvailable = native !== null;

/** Replaces every waiting call with these. */
export function scheduleCalls(calls: CallSpec[]): void {
  native?.schedule(calls);
}

export function cancelCall(id: string): void {
  native?.cancel(id);
}

/** Rings in `seconds` (the test call). */
export function ringIn(seconds: number, call: Omit<CallSpec, 'at'>): void {
  native?.ringIn(seconds, call);
}

export function stopRinging(id: string): void {
  native?.stopRinging(id);
}

/** Android 14+ needs the user's OK to ring over the lock screen. */
export function canRingFullScreen(): boolean {
  return native?.canRingFullScreen() ?? true;
}

export function openFullScreenSettings(): void {
  native?.openFullScreenSettings();
}
