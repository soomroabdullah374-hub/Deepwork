// The live level of the microphone as a row of moving bars (the assistant and calls).

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { palette } from '@/lib/theme';

export function VoiceBars({ level, active, count = 14, height = 44, color = palette.dark.mark }: { level: number; active: boolean; count?: number; height?: number; color?: string }) {
  const [history, setHistory] = useState<number[]>(() => Array(count).fill(0.15));
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setHistory((h) => [...h.slice(1), Math.max(0.12, Math.min(1, levelRef.current * (0.75 + Math.random() * 0.5)))]);
    }, 90);
    return () => clearInterval(t);
  }, [active]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: height > 30 ? 5 : 3, height }} accessibilityElementsHidden>
      {history.map((v, i) => (
        <View key={i} style={{ width: height > 30 ? 4 : 3, height: 4 + v * (height - 6), borderRadius: 2, backgroundColor: color, opacity: active ? 1 : 0.4 }} />
      ))}
    </View>
  );
}
