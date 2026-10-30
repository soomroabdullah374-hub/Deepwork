// Line icons on a 24 pt grid (2 pt stroke, round ends), drawn with react-native-svg.

import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '@/lib/theme';

const paths: Record<string, (fill: string) => React.ReactNode> = {
  calendar: () => (
    <>
      <Rect x={3} y={4.5} width={18} height={17} rx={3} />
      <Path d="M16 2.5v4M8 2.5v4M3 10h18" />
    </>
  ),
  target: () => (
    <>
      <Circle cx={12} cy={12} r={9.5} />
      <Circle cx={12} cy={12} r={5.5} />
      <Circle cx={12} cy={12} r={1.6} />
    </>
  ),
  mic: () => (
    <>
      <Rect x={9} y={2.5} width={6} height={12} rx={3} />
      <Path d="M18.5 10.5v1a6.5 6.5 0 0 1-13 0v-1M12 18v3.5" />
    </>
  ),
  bars: () => <Path d="M6 20v-7M12 20V5M18 20v-10" />,
  sliders: () => <Path d="M21 5h-7M10 5H3M21 12h-9M8 12H3M21 19h-5M12 19H3M14 3v4M8 10v4M16 17v4" />,
  plus: () => <Path d="M12 5v14M5 12h14" />,
  minus: () => <Path d="M5 12h14" />,
  chevronLeft: () => <Path d="M15 18l-6-6 6-6" />,
  chevronRight: () => <Path d="M9 18l6-6-6-6" />,
  chevronDown: () => <Path d="M6 9l6 6 6-6" />,
  chevronUp: () => <Path d="M18 15l-6-6-6 6" />,
  x: () => <Path d="M18 6L6 18M6 6l12 12" />,
  check: () => <Path d="M20 6.5L9.5 17 4 11.5" />,
  play: (f) => <Path d="M8 5.5v13l10.5-6.5z" fill={f} stroke="none" />,
  pause: (f) => (
    <>
      <Rect x={6.5} y={5} width={3.6} height={14} rx={1} fill={f} stroke="none" />
      <Rect x={13.9} y={5} width={3.6} height={14} rx={1} fill={f} stroke="none" />
    </>
  ),
  stop: (f) => <Rect x={6.5} y={6.5} width={11} height={11} rx={2} fill={f} stroke="none" />,
  alarm: () => (
    <>
      <Circle cx={12} cy={13} r={7.5} />
      <Path d="M12 9.5V13l2.2 2.2M4.5 3.5l-2.5 2.5M22 6l-2.5-2.5" />
    </>
  ),
  arrowRight: () => <Path d="M5 12h14M13 6l6 6-6 6" />,
  arrowUp: () => <Path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: () => <Path d="M12 5v14M18 13l-6 6-6-6" />,
  mail: () => (
    <>
      <Rect x={2.5} y={4.5} width={19} height={15} rx={2.5} />
      <Path d="M3 7l9 6 9-6" />
    </>
  ),
  lock: () => (
    <>
      <Rect x={4} y={10.5} width={16} height={11} rx={2.5} />
      <Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  eye: () => (
    <>
      <Path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <Circle cx={12} cy={12} r={3} />
    </>
  ),
  eyeOff: () => (
    <Path d="M9.9 5.7A9.4 9.4 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-2.5 3.3M6.6 6.6C3.7 8.4 2 12 2 12s3.6 6.5 10 6.5a9.6 9.6 0 0 0 5.3-1.6M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  ),
  send: () => <Path d="M21.5 2.5L10.5 13.5M21.5 2.5l-7 19-4-8-8-4z" />,
  retry: () => <Path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 3.5v5h5" />,
  download: () => <Path d="M12 3v12M7 10l5 5 5-5M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" />,
  pencil: () => <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />,
  moon: () => <Path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.5 6.5 0 0 0 11 11z" />,
  keyboard: () => (
    <>
      <Rect x={2.5} y={5.5} width={19} height={13} rx={2.5} />
      <Path d="M6.5 9.5h1M10.5 9.5h1M14.5 9.5h1M6.5 12.5h1M16.5 9.5h1M8.5 15.5h7M16.5 12.5h1M10.5 12.5h3" />
    </>
  ),
  grip: (f) => (
    <>
      {[6, 12, 18].map((y) => (
        <Circle key={`a${y}`} cx={9} cy={y} r={1.4} fill={f} stroke="none" />
      ))}
      {[6, 12, 18].map((y) => (
        <Circle key={`b${y}`} cx={15} cy={y} r={1.4} fill={f} stroke="none" />
      ))}
    </>
  ),
  trash: () => <Path d="M3.5 6h17M9 6V4h6v2M18.5 6l-.9 14a1.5 1.5 0 0 1-1.5 1.4H7.9a1.5 1.5 0 0 1-1.5-1.4L5.5 6M10 10.5v6M14 10.5v6" />,
  clock: () => (
    <>
      <Circle cx={12} cy={12} r={9.5} />
      <Path d="M12 7v5l3 2" />
    </>
  ),
  flag: () => <Path d="M5 21.5V4M5 4h12l-2.5 4 2.5 4H5" />,
  alert: () => (
    <>
      <Circle cx={12} cy={12} r={9.5} />
      <Path d="M12 7.5v5M12 16.2v.1" />
    </>
  ),
  question: () => (
    <>
      <Path d="M9 9a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.9v.5M12 17.3v.1" />
    </>
  ),
  ban: () => (
    <>
      <Circle cx={12} cy={12} r={9.5} />
      <Path d="M5.3 5.3l13.4 13.4" />
    </>
  ),
  logout: () => <Path d="M9 21H5.5A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3H9M15.5 16.5L20 12l-4.5-4.5M20 12H9" />,
  bell: () => <Path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9zM10 21a2.3 2.3 0 0 0 4 0" />,
  speaker: () => <Path d="M11 5L6.5 9H3v6h3.5l4.5 4zM15.5 9a4.5 4.5 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12" />,
  shield: () => <Path d="M12 2.5l8 3v6c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10v-6z" />,
  globe: () => (
    <>
      <Circle cx={12} cy={12} r={9.5} />
      <Path d="M2.5 12h19M12 2.5c2.6 2.8 3.8 6 3.8 9.5S14.6 18.7 12 21.5C9.4 18.7 8.2 15.5 8.2 12S9.4 5.3 12 2.5z" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 22,
  color,
  strokeWidth = 1.9,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const { c } = useTheme();
  const stroke = color ?? c.text;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name](stroke)}
    </Svg>
  );
}
