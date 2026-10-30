// [13] Sign in / Create account with Neon Auth: email + password, an emailed code
// (also the "Forgot?" path), or Google.

import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { sendCode, signIn, signInWithGoogle, signUp, verifyCode } from '@/lib/auth';
import { errorMessage } from '@/lib/http';
import { fonts, useTheme } from '@/lib/theme';
import { Button, Field, Icon, Screen, Segmented, T, Wordmark } from '@/ui';

type Mode = 'sign_in' | 'create';

export default function SignIn() {
  const { c } = useTheme();
  const [mode, setMode] = useState<Mode>('sign_in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<null | 'main' | 'code' | 'google'>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => router.replace('/today');
  const run = async (which: 'main' | 'code' | 'google', fn: () => Promise<void | boolean>) => {
    setError(null);
    setBusy(which);
    try {
      const ok = await fn();
      if (ok !== false) done();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit = validEmail && password.length >= 8 && (mode === 'sign_in' || name.trim().length > 0);

  const askForCode = async () => {
    if (!validEmail) {
      setError('Enter your email first, then we can send you a code.');
      return;
    }
    setError(null);
    setBusy('code');
    try {
      await sendCode(email.trim());
      setCodeSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          <T variant="caption" tone="secondary" align="center">
            By continuing you agree to the{' '}
            <Link href="/privacy" style={{ color: c.button, textDecorationLine: 'underline' }}>
              Privacy Policy
            </Link>
            .
          </T>
        }
      >
        <View style={{ marginTop: 24, gap: 10 }}>
          <Wordmark size={34} />
          <T variant="display" style={{ marginTop: 12 }}>
            {mode === 'sign_in' ? 'Welcome back.' : 'Create your account.'}
          </T>
          <T tone="secondary">Your goals and sessions sync across your devices.</T>
        </View>

        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
            setCodeSent(false);
          }}
          options={[
            { value: 'sign_in', label: 'Sign in' },
            { value: 'create', label: 'Create account' },
          ]}
        />

        {codeSent ? (
          <View style={{ gap: 14 }}>
            <T tone="secondary">
              We sent a code to <T style={{ fontFamily: fonts.uiBold }}>{email.trim()}</T>. It expires in a few minutes.
            </T>
            <Field
              label="Code"
              icon="lock"
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 8))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              placeholder="6-digit code"
              style={{ fontFamily: fonts.mono, letterSpacing: 4 }}
            />
            <Button
              label="Sign in with code"
              disabled={code.length < 6}
              loading={busy === 'code'}
              onPress={() => run('code', () => verifyCode(email.trim(), code))}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Button label="Send a new code" variant="link" onPress={askForCode} />
              <Button label="Use password" variant="link" onPress={() => setCodeSent(false)} />
            </View>
          </View>
        ) : (
          <View style={{ gap: 14 }}>
            {mode === 'create' ? (
              <Field label="Name" icon="target" value={name} onChangeText={setName} placeholder="What should we call you?" autoComplete="name" textContentType="name" />
            ) : null}
            <Field
              label="Email"
              icon="mail"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
            />
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T variant="label" style={{ fontFamily: fonts.uiBold }}>
                  Password
                </T>
                {mode === 'sign_in' ? (
                  <Pressable onPress={askForCode} accessibilityRole="button" accessibilityLabel="Forgot password? Email me a sign-in code" hitSlop={10}>
                    <T variant="label" tone="button">
                      Forgot?
                    </T>
                  </Pressable>
                ) : null}
              </View>
              <Field
                icon="lock"
                value={password}
                onChangeText={setPassword}
                placeholder="At least 8 characters"
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                textContentType={mode === 'create' ? 'newPassword' : 'password'}
                right={
                  <Pressable onPress={() => setShowPassword((s) => !s)} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} hitSlop={10}>
                    <Icon name={showPassword ? 'eyeOff' : 'eye'} size={20} color={c.textSecondary} />
                  </Pressable>
                }
              />
            </View>
            <Button
              label={mode === 'sign_in' ? 'Sign in' : 'Create account'}
              disabled={!canSubmit}
              loading={busy === 'main'}
              onPress={() =>
                run('main', () => (mode === 'sign_in' ? signIn(email.trim(), password) : signUp(name.trim(), email.trim(), password)))
              }
            />
          </View>
        )}

        {error ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }} accessibilityLiveRegion="polite">
            <Icon name="alert" size={18} color={c.danger} />
            <T variant="bodySm" tone="danger" style={{ flex: 1 }}>
              {error}
            </T>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
          <T variant="caption" tone="secondary">
            or
          </T>
          <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
        </View>
        {!codeSent ? (
          <Button label="Email me a sign-in code" icon="send" variant="secondary" loading={busy === 'code'} onPress={askForCode} />
        ) : null}
        <Button label="Continue with Google" variant="outline" loading={busy === 'google'} onPress={() => run('google', signInWithGoogle)} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
