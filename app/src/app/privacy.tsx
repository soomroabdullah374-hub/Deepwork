// Privacy policy (also in PRIVACY.md at the repository root).

import { Screen, T, TopBar } from '@/ui';

const SECTIONS: [string, string][] = [
  ['What DeepWork stores', 'A private account for your phone (no email or password from you: the app makes up a random one and keeps it in the phone\'s secure storage), the name you add, your goals, milestones, weekly rhythm, commitments, calendar blocks and session history, your settings, and a log of assistant requests (the words you said or typed, the plan, and what was applied). This keeps your plan safe on the server and lets you undo assistant changes.'],
  ['Voice', 'Recording only happens while the assistant screen is listening. The clip is sent to AssemblyAI to turn it into text and is not kept by DeepWork. The text is sent to the language model provider (Groq or xAI) to plan the change. Spoken replies are made by ElevenLabs from the reply text.'],
  ['Where it lives', 'Data is stored in a Neon Postgres database (Singapore region) with row-level security, so each account can only read its own rows. The API runs on Supabase Edge Functions. The phone\'s account is handled by Neon Auth.'],
  ['Reminders', 'Reminders are sent by our server through Google Firebase Cloud Messaging, which needs your phone\'s push token (stored with your account and deleted with it), or, without push, scheduled on your phone from your synced schedule. When the assistant speaks without the ElevenLabs voice, your phone\'s own text-to-speech is used. No advertising or tracking SDKs are included.'],
  ['Your choices', 'Settings › Export everything gives you all your data as JSON. Settings › Delete all my data removes the phone\'s account and every row tied to it, immediately and permanently.'],
  ['Contact', 'Questions or requests: open an issue at github.com/soomroabdullah374-hub/Deepwork.'],
];

export default function Privacy() {
  return (
    <Screen>
      <TopBar title="Privacy policy" />
      <T variant="h1">Privacy policy</T>
      <T tone="secondary">Last updated 30 October 2026.</T>
      {SECTIONS.map(([h, body]) => (
        <T key={h} variant="body">
          <T variant="label">{`${h}\n`}</T>
          {body}
        </T>
      ))}
    </Screen>
  );
}
