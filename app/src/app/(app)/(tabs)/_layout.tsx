import { Tabs } from 'expo-router';
import { useTheme } from '@/lib/theme';
import { TabBar } from '@/ui';

export default function TabsLayout() {
  const { c } = useTheme();
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.bg }, animation: 'fade' }}
      tabBar={() => <TabBar />}
    >
      <Tabs.Screen name="today" />
      <Tabs.Screen name="goals" />
      <Tabs.Screen name="insights" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
