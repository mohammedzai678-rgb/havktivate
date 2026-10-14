import { useEffect, useRef, useState } from 'react';
import { SERVER_URL, listenOnce } from '../lib/voiceClient';

type ReminderSlot = 'morning' | 'afternoon' | 'evening';
type Schedule = Record<ReminderSlot, string>;

const DEFAULTS: Schedule = { morning: '08:00', afternoon: '14:00', evening: '20:00' };
const SLOT_ALIASES: Record<ReminderSlot, string[]> = {
  morning: ['morning', 'breakfast', 'subah', 'सुबह'],
  afternoon: ['afternoon', 'noon', 'lunch', 'dopahar', 'दोपहर'],
  evening: ['evening', 'night', 'dinner', 'shaam', 'शाम'],
};

function playReminderChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880.0, now + 0.18); // A5
    osc.frequency.setValueAtTime(1174.66, now + 0.36); // D6
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.4);
  } catch {
    // Web Audio blocked or unsupported
  }
}

function speakText(text: string) {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch {
      // SpeechSynthesis error ignored
    }
  }
}

function nearestSlot(text: string, start: number, end: number): ReminderSlot | null {
  let selected: ReminderSlot | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  for (const slot of Object.keys(SLOT_ALIASES) as ReminderSlot[]) {
    for (const alias of SLOT_ALIASES[slot]) {
      let from = Math.max(0, start - 36);
      while (from < Math.min(text.length, end + 36)) {
        const position = text.indexOf(alias, from);
        if (position < 0 || position > end + 36) break;
        const distance = position < start ? start - (position + alias.length) : position - end;
        if (distance < nearest) {
          selected = slot;
          nearest = distance;
        }
        from = position + alias.length;
      }
    }
  }
  return nearest <= 36 ? selected : null;
}

function parseSpokenSchedule(transcript: string, current: Schedule): Schedule | null {
  const text = transcript.toLowerCase();
  const next = { ...current };
  const timePattern = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
  let found = false;
  let match: RegExpExecArray | null;

  while ((match = timePattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const slot = nearestSlot(text, start, end);
    if (!slot) continue;

    let hour = Number(match[1]);
    const minute = Number(match[2] ?? '0');
    const meridiem = (match[3] ?? '').replaceAll('.', '').toLowerCase();
    if (minute > 59) continue;
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
      else hour = hour === 12 ? 12 : hour + 12;
    } else if (hour <= 12) {
      if (slot === 'afternoon' || slot === 'evening') hour = hour === 12 ? 12 : hour + 12;
      else if (hour === 12) hour = 0;
    } else if (hour > 23) {
      continue;
    }

    next[slot] = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    found = true;
  }
  return found ? next : null;
}

export function MedicineReminderPanel({
  speechCode, onBeforeVoiceInput,
}: {
  speechCode: string;
  onBeforeVoiceInput: () => Promise<void>;
}) {
  const [schedule, setSchedule] = useState<Schedule>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [transcript, setTranscript] = useState('');
  const [activeAlert, setActiveAlert] = useState<{ slot: string; time: string } | null>(null);

  const lastTriggeredMinute = useRef<string>('');

  useEffect(() => {
    let alive = true;
    fetch(SERVER_URL + '/api/device/reminders', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load reminder times.');
        const body = await response.json();
        const reminders = body.reminders ?? {};
        if (alive) setSchedule({
          morning: reminders.morning || DEFAULTS.morning,
          afternoon: reminders.afternoon || DEFAULTS.afternoon,
          evening: reminders.evening || DEFAULTS.evening,
        });
      })
      .catch(() => { if (alive) setError('Reminder service is unavailable. Start the local server and try again.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const triggerAlert = (slot: string, timeStr: string) => {
    setActiveAlert({ slot, time: timeStr });
    playReminderChime();
    speakText(`Attention: It is time to take your ${slot} medicine. Please take your prescribed pills.`);
    // Notify server to turn on ESP32 LED & display alert
    fetch(SERVER_URL + '/api/device/reminders/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, slot }),
    }).catch(() => {});
  };

  const dismissAlert = () => {
    setActiveAlert(null);
    speakText('Medicine reminder acknowledged. Great job staying on track.');
    // Notify server to turn off ESP32 LED
    fetch(SERVER_URL + '/api/device/reminders/acknowledge', { method: 'POST' }).catch(() => {});
  };

  // Real-time clock watcher: checks every 2 seconds if current time matches a reminder slot
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const currentHHMM = `${hh}:${mm}`;
      const todayDateKey = `${now.toDateString()}_${currentHHMM}`;

      if (lastTriggeredMinute.current === todayDateKey) return;

      for (const slot of ['morning', 'afternoon', 'evening'] as ReminderSlot[]) {
        if (schedule[slot] === currentHHMM) {
          lastTriggeredMinute.current = todayDateKey;
          triggerAlert(slot, currentHHMM);
          break;
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [schedule]);

  const saveSchedule = async (next: Schedule, confirmation: string) => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(SERVER_URL + '/api/device/reminders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error('Could not save the reminder times.');
      const body = await response.json();
      setSchedule(body.reminders ?? next);
      setMessage(confirmation);
    } catch {
      setError('Could not save reminder times. Check the local server connection.');
    } finally {
      setSaving(false);
    }
  };

  const setByVoice = async () => {
    setListening(true);
    setError('');
    setMessage('');
    setTranscript('');
    try {
      await onBeforeVoiceInput();
      const heard = await listenOnce(speechCode, 15_000).promise;
      if (!heard) {
        setError('No reminder times were heard. Try: “morning 8 AM, afternoon 2 PM, evening 8 PM.”');
        return;
      }
      setTranscript(heard);
      const next = parseSpokenSchedule(heard, schedule);
      if (!next) {
        setError('I could not match the times to morning, afternoon, or evening. Say each time with its meal period.');
        return;
      }
      await saveSchedule(next, 'Reminder times saved from your voice.');
    } catch {
      setError('Voice input could not start. Allow microphone access and try again.');
    } finally {
      setListening(false);
    }
  };

  const updateTime = (slot: ReminderSlot, value: string) =>
    setSchedule((previous) => ({ ...previous, [slot]: value }));

  const card: React.CSSProperties = {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 18, padding: 18,
    boxShadow: '0 2px 10px rgba(15,23,42,0.04)', marginBottom: 20,
  };
  const input: React.CSSProperties = {
    padding: '9px 11px', borderRadius: 10, border: '1px solid #cbd5e1',
    fontSize: 14, background: '#fff',
  };
  const button: React.CSSProperties = {
    padding: '10px 14px', borderRadius: 10, border: '1px solid #0f766e',
    background: '#0f766e', color: '#fff', fontWeight: 700, cursor: 'pointer',
  };

  return (
    <section style={card}>
      {activeAlert && (
        <div style={{
          marginBottom: 16, padding: '16px 20px', borderRadius: 14,
          background: 'linear-gradient(135deg, #fef3c7 0%, #fee2e2 100%)',
          border: '2px solid #f59e0b', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
          animation: 'pulse 1.5s infinite',
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#9a3412', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🔔</span> MEDICINE TIME: Take your {activeAlert.slot.toUpperCase()} medicine! ({activeAlert.time})
            </div>
            <div style={{ fontSize: 13, color: '#7c2d12', marginTop: 4 }}>
              ESP32 LED is lit. Please take your prescribed pills and acknowledge below or press the hardware button.
            </div>
          </div>
          <button type="button" onClick={dismissAlert} style={{
            ...button, background: '#059669', borderColor: '#047857', fontSize: 14, padding: '10px 18px',
          }}>
            ✓ I Took My Medicine (Turn Off LED)
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19, color: '#0f172a' }}>Medicine reminders</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Voice alerts play and the ESP32 LED lights up at each scheduled time until acknowledged.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => triggerAlert('morning (test)', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
            style={{ ...button, background: '#fff', color: '#b45309', borderColor: '#fde68a' }} title="Test the voice announcement and ESP32 LED right now">
            🔔 Test Voice & LED
          </button>
          <button type="button" onClick={() => void setByVoice()} disabled={listening || saving || loading} style={{ ...button, opacity: listening || saving || loading ? 0.65 : 1 }}>
            {listening ? 'Listening…' : '🎙 Set times by voice'}
          </button>
        </div>
      </div>

      <p style={{ margin: '12px 0', fontSize: 13, color: '#475569' }}>
        Try: “Morning 8 AM, afternoon 2 PM, evening 8 PM.”
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {(['morning', 'afternoon', 'evening'] as ReminderSlot[]).map((slot) => (
          <label key={slot} style={{ display: 'grid', gap: 5, color: '#64748b', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' }}>
            {slot}
            <input type="time" value={schedule[slot]} disabled={loading || saving} onChange={(event) => updateTime(slot, event.target.value)} style={input} />
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" disabled={loading || saving || listening} onClick={() => void saveSchedule(schedule, 'Reminder times saved.')} style={{ ...button, background: '#fff', color: '#0f766e', opacity: loading || saving || listening ? 0.65 : 1 }}>
          {saving ? 'Saving…' : loading ? 'Loading…' : 'Save reminder times'}
        </button>
        {message && <span role="status" style={{ color: '#047857', fontSize: 13 }}>{message}</span>}
      </div>

      {transcript && <p style={{ margin: '10px 0 0', color: '#64748b', fontSize: 12 }}>Heard: “{transcript}”</p>}
      {error && <p role="alert" style={{ margin: '10px 0 0', color: '#b91c1c', fontSize: 13 }}>{error}</p>}
    </section>
  );
}
