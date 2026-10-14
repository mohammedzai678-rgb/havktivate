import { useCallback, useEffect, useRef, useState } from 'react';
import { SERVER_URL } from '../lib/voiceClient';

export interface DeviceStatus {
  online: boolean;
  sensor: string;
  data: Record<string, any>;
  age_ms: number;
  updated_at: number;
  can_command: boolean;
  reachable: boolean;
}

const POLL_INTERVAL_MS = 2500;
const MAX_SAMPLE_AGE_MS = 10_000;
const pageIsVisible = () => document.visibilityState === 'visible';

/** Poll the ESP32 feed without overlapping requests or waking a hidden tab. */
export function useDeviceFeed(onSample: (sensor: string, data: Record<string, any>, ts: number) => void) {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const cb = useRef(onSample);
  cb.current = onSample;
  const lastSeen = useRef(0);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let timer = 0;

    const poll = async () => {
      if (!alive || !pageIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`${SERVER_URL}/api/device/status`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Device status ${res.status}`);
        const s = (await res.json()) as DeviceStatus;
        if (!alive) return;
        setServerUp(true);
        setStatus(s);
        if (s.online && s.updated_at > 0 && s.age_ms < MAX_SAMPLE_AGE_MS && s.updated_at !== lastSeen.current) {
          lastSeen.current = s.updated_at;
          cb.current(s.sensor, s.data ?? {}, s.updated_at);
        }
      } catch {
        if (alive) setServerUp(false);
      } finally {
        inFlight = false;
        if (alive && pageIsVisible()) {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (pageIsVisible()) void poll();
    };

    void poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const sendCommand = useCallback(async (command: string) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/device/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  return { status, serverUp, sendCommand };
}

