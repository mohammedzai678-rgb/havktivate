import { useCallback, useEffect, useRef, useState } from 'react';
import { SERVER_URL, Speaker, type VoiceEngine } from '../lib/voiceClient';

/**
 * ESP32 #2 - Walking stick (3 ultrasonic sensors + LDR automatic light).
 * Polls the local server for new stick events and SPEAKS them, e.g.
 *   "The room is dark. Turning on the light. Please be cautious."
 *   "Obstacle on your right. Take left."
 *   "You are touching something in front of you. Stop and step back."
 */
export interface StickEvent {
  id: number;
  source: 'stick' | 'light';
  code: string;
  message: string;
  priority: number;
  data: Record<string, any>;
  received_at: number;
}

export interface StickStatus {
  online: boolean;
  device_id: string;
  data: Record<string, any>;
  updated_at: number;
  age_ms: number;
  latest_event_id: number;
}

const EVENT_POLL_MS = 500;
const STATUS_POLL_MS = 1500;
const ENABLED_KEY = 'jeevan_stick_voice_enabled_v1';

export function useStickFeed(opts: { onSpoken?: (ev: StickEvent) => void } = {}) {
  const [status, setStatus] = useState<StickStatus | null>(null);
  const [events, setEvents] = useState<StickEvent[]>([]);
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const [voiceEnabled, setVoiceEnabledState] = useState<boolean>(() => {
    try { return localStorage.getItem(ENABLED_KEY) !== 'false'; } catch { return true; }
  });

  const speakerRef = useRef<Speaker | null>(null);
  if (!speakerRef.current) speakerRef.current = new Speaker();
  const queueRef = useRef<StickEvent[]>([]);
  const speakingRef = useRef<StickEvent | null>(null);
  const enabledRef = useRef(voiceEnabled);
  enabledRef.current = voiceEnabled;
  const onSpokenRef = useRef(opts.onSpoken);
  onSpokenRef.current = opts.onSpoken;

  const pump = useCallback(async () => {
    if (speakingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    speakingRef.current = next;
    onSpokenRef.current?.(next);
    try {
      setEngine(await speakerRef.current!.speak(next.message, 'en', 'en-IN'));
    } finally {
      speakingRef.current = null;
      void pump();
    }
  }, []);

  const enqueue = useCallback((ev: StickEvent) => {
    if (!enabledRef.current) return;
    // Only the newest message per source matters (old guidance is stale).
    queueRef.current = queueRef.current.filter((q) => q.source !== ev.source);
    const current = speakingRef.current;
    // Urgent guidance interrupts a less important / same-source message.
    if (current && ev.priority >= 2 && (ev.priority > current.priority || current.source === ev.source)) {
      queueRef.current.unshift(ev);
      speakerRef.current!.stop();
      return;
    }
    if (ev.priority >= 3) queueRef.current.unshift(ev);
    else queueRef.current.push(ev);
    void pump();
  }, [pump]);

  // New events -> speak
  useEffect(() => {
    let alive = true;
    let after = -1;
    let timer = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/stick/events?after=${after}`, { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as { events: StickEvent[]; latest_event_id: number };
          if (!alive) return;
          if (body.latest_event_id < after) after = -1;       // server restarted
          if (after >= 0 && body.events.length) {
            setEvents((list) => [...list, ...body.events].slice(-40));
            body.events.forEach(enqueue);
          }
          after = body.latest_event_id;
        }
      } catch { /* server not running */ }
      if (alive) timer = window.setTimeout(poll, EVENT_POLL_MS);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [enqueue]);

  // Live status (distances, LDR, LED)
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/stick/status`, { cache: 'no-store' });
        if (res.ok && alive) setStatus((await res.json()) as StickStatus);
      } catch { if (alive) setStatus(null); }
    };
    void poll();
    const i = window.setInterval(poll, STATUS_POLL_MS);
    return () => { alive = false; window.clearInterval(i); };
  }, []);

  useEffect(() => () => speakerRef.current?.stop(), []);

  const setVoiceEnabled = useCallback(async (on: boolean) => {
    setVoiceEnabledState(on);
    try { localStorage.setItem(ENABLED_KEY, String(on)); } catch { /* ignore */ }
    if (!on) {
      queueRef.current = [];
      speakerRef.current!.stop();
    } else {
      // Clicking the button is a user gesture: this also unlocks browser audio.
      setEngine(await speakerRef.current!.speak('Walking stick voice guidance is on.', 'en', 'en-IN'));
    }
  }, []);

  const setOutputDevice = useCallback((id: string) => { speakerRef.current!.sinkId = id; }, []);

  return { status, events, engine, voiceEnabled, setVoiceEnabled, setOutputDevice };
}
