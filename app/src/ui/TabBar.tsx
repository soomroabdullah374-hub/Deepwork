// Floating tab bar: Today, Goals, raised mic (opens the assistant), Insights, Settings.

import * as Haptics from 'expo-haptics';
import { router, usePathname } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, useTheme } from '@/lib/theme';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

const TABS: { href: '/today' | '/goals' | '/insights' | '/settings'; label: string; icon: IconName }[] = [
  { href: '/today', label: 'Today', icon: 'calendar' },
  { href: '/goals', label: 'Goals', icon: 'target' },
  { href: '/insights', label: 'Insights', icon: 'bars' },
  { href: '/settings', label: 'Settings', icon: 'sliders' },
];

export const TAB_BAR_SPACE = 68 + 20 + 16;

export function TabBar() {
  const { c, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const path = usePathname();
  const item = (t: (typeof TABS)[number]) => {
    const on = path === t.href || path.startsWith(`${t.href}/`);
    const color = on ? c.button : c.textSecondary;
    return (
      <Pressable
        key={t.href}
        onPress={() => {
          Haptics.selectionAsync().catch(() => undefined);
          router.navigate(t.href);
        }}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={t.label}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 56 }}
      >
        <Icon name={t.icon} size={22} color={on ? c.mark : c.textSecondary} />
        <T variant="tab" color={color}>
          {t.label}
        </T>
      </Pressable>
    );
  };
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12) + 8 }}
    >
      <View
        accessibilityRole="tablist"
        style={{
          height: 68,
          borderRadius: radius.tabBar,
          backgroundColor: c.surface,
          borderWidth: 1,
          borderColor: c.line,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 6,
          shadowColor: '#000',
          shadowOpacity: scheme === 'light' ? 0.08 : 0.4,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 8,
        }}
      >
        {item(TABS[0])}
        {item(TABS[1])}
        <View style={{ width: 72, alignItems: 'center' }}>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
              router.push('/assistant');
            }}
            accessibilityRole="button"
            accessibilityLabel="Talk to the assistant"
            style={({ pressed }) => ({
              width: 60,
              height: 60,
              borderRadius: 30,
              marginTop: -30,
              backgroundColor: c.button,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 4,
              borderColor: c.bg,
              transform: [{ scale: pressed ? 0.95 : 1 }],
              shadowColor: '#B8532F',
              shadowOpacity: 0.35,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 6 },
              elevation: 10,
            })}
          >
            <Icon name="mic" size={24} color="#FAF9F5" />
          </Pressable>
        </View>
        {item(TABS[2])}
        {item(TABS[3])}
      </View>
    </View>
  );
}
