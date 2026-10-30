// [12] Onboarding: three swipeable slides on a Sand panel.

import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { FlatList, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setFlag } from '@/lib/prefs';
import { fonts, useTheme } from '@/lib/theme';
import { BrandRow, Button, IconButton, ReminderCard, RingFlag, T, WeekColumns } from '@/ui';

const SLIDES = [
  { key: '1', title: 'Start with one goal.', body: "Name what you want to finish and when it's due. That's the whole setup.", art: 'ring' },
  { key: '2', title: 'Same days. Same time.', body: 'Pick your rhythm once. DeepWork books the sessions around everything else in your week.', art: 'week' },
  { key: '3', title: 'A nudge, not a nag.', body: 'A short reminder before each block. Missed one? Move it with a tap, no guilt.', art: 'reminder' },
] as const;

export default function Onboarding() {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  const list = useRef<FlatList>(null);

  const finish = async () => {
    await setFlag('onboarded');
    router.replace('/sign-in');
  };
  const next = () => {
    if (index < SLIDES.length - 1) list.current?.scrollToIndex({ index: index + 1 });
    else finish();
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <FlatList
        ref={list}
        data={SLIDES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(s) => s.key}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item, index: i }) => (
          <View style={{ width }}>
            <View
              style={{
                height: 440,
                backgroundColor: c.sand,
                borderBottomLeftRadius: 36,
                borderBottomRightRadius: 36,
                paddingTop: insets.top + 12,
                paddingHorizontal: 20,
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 }}>
                <BrandRow />
                <Pressable onPress={finish} accessibilityRole="button" accessibilityLabel="Skip" hitSlop={10}>
                  <T variant="label">Skip</T>
                </Pressable>
              </View>
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                {item.art === 'ring' ? <RingFlag size={190} track={c.surface} /> : item.art === 'week' ? <WeekColumns /> : <ReminderCard />}
              </View>
            </View>
            <View style={{ paddingHorizontal: 20, paddingTop: 28, gap: 12 }}>
              <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
                {`0${i + 1} / 03`}
              </T>
              <T variant="display">{item.title}</T>
              <T tone="secondary">{item.body}</T>
            </View>
          </View>
        )}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 8 }} accessibilityLabel={`Slide ${index + 1} of 3`}>
          {SLIDES.map((s, i) => (
            <View key={s.key} style={{ width: i === index ? 28 : 8, height: 8, borderRadius: 4, backgroundColor: i === index ? c.mark : c.lineStrong }} />
          ))}
        </View>
        {index === SLIDES.length - 1 ? (
          <Button label="Get started" iconRight="arrowRight" onPress={finish} style={{ borderRadius: 999, paddingHorizontal: 24 }} />
        ) : (
          <IconButton icon="arrowRight" label="Next" tone="kiln" size={64} iconSize={24} onPress={next} />
        )}
      </View>
    </View>
  );
}
