import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { bootstrap, onAccountReset } from '@/lib/auth';
import { useBanner } from '@/lib/banner';
import { clearReminders, setupNotifications } from '@/lib/notifications';
import { loadPrefs, useThemePreference } from '@/lib/prefs';
import { queryClient } from '@/lib/queries';
import { fontFiles, palette, ThemeProvider, useTheme } from '@/lib/theme';
import { Banner } from '@/ui';

SplashScreen.preventAutoHideAsync().catch(() => undefined);
loadPrefs().catch(() => undefined);
setupNotifications().catch(() => undefined);
// Restore this phone's account for every entry point (launch, deep links, notification taps).
bootstrap().catch(() => undefined);
onAccountReset(async () => {
  queryClient.clear();
  await clearReminders();
});

function BannerHost() {
  const banner = useBanner();
  const insets = useSafeAreaInsets();
  if (!banner) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 100 }}>
      <Animated.View key={banner.id} entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(180)}>
        <Banner message={banner.text} tone={banner.tone} />
      </Animated.View>
    </View>
  );
}

function Shell() {
  const { scheme, c } = useTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(c.bg).catch(() => undefined);
  }, [c.bg]);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}>
        <Stack.Screen name="index" options={{ animation: 'fade' }} />
        <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        <Stack.Screen name="(app)" options={{ animation: 'fade' }} />
      </Stack>
      <BannerHost />
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const preference = useThemePreference();
  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => undefined);
  }, [fontsLoaded, fontError]);
  if (!fontsLoaded && !fontError) return <View style={{ flex: 1, backgroundColor: palette.light.button }} />;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider preference={preference}>
            <Shell />
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
