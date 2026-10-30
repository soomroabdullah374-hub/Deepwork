// deepwork://auth/callback is consumed by the sign-in browser session; if the system
// opens it as a link instead, just go home.

import { Redirect } from 'expo-router';

export default function AuthCallback() {
  return <Redirect href="/" />;
}
