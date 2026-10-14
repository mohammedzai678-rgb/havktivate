import { useCallback, useEffect, useRef, useState } from 'react';
import { useDeviceFeed } from './useDeviceFeed';
import {
  adaptSensitivity, analyze, detectTrigger, effectiveBaseline, loadBaselines, loadSensitivity,
  saveBaselines, saveSensitivity, updateBaseline,
  type Analysis, type Baselines, type MetricKey, type Sample, type Sensitivity, type Trigger, type TriggerTopic,
} from '../lib/anticipation';
import {
  fetchConverse, fetchPhrases, fetchQuestion, listenOnce, localIntent, localYesNo, Speaker,
  type ConverseResult, type Listener, type Phrases, type Turn, type VoiceEngine,
} from '../lib/voiceClient';

export type AgentStatus = 'off' | 'monitoring' | 'speaking' | 'listening' | 'thinking';
export type RotateMode = 'auto' | 'hr' | 'temp';
export type SimKind = 'calm' | 'nervous' | 'fever' | null;

export interface LogEntry { id: number; t: number; who: 'agent' | 'user' | 'system'; text: string; reason?: string }
export interface VoiceAgentOptions {
  language: string;
  speechCode: string;
  person: string;
  caregiver: { name: string; phone: string };
  rotate: RotateMode;
}

const FALLBACK_PHRASES: Phrases = {
  greeting: 'Hi, I am there to help you.',
  reprompt: 'I am here. Are you feeling alright?',
  check_again: 'Okay. I will check on you again in a little while.',
  stay_nearby: 'That is fine. I will stay nearby.',
  breathe_in: 'Breathe in slowly.',
  hold: 'Hold gently.',
  breathe_out: 'Now breathe out slowly.',
  breathing_done: 'Well done. Let us see how your readings settle.',
  alert_prepared: 'I have prepared a message for {name}. Please tap send on the screen.',
  no_caregiver: 'I could not find a caregiver number. Please add one on the screen.',
  q_nervous: 'Your heartbeat seems a little fast. Are you feeling nervous or restless?',
  q_rising_hr: 'Your heartbeat has been climbing for a while. Are you alright?',
  q_high_temp: 'Your temperature seems high. Are you feeling hot or feverish?',
  q_rising_temp: 'Your temperature is slowly rising. Do you feel warm or unwell?',
  q_low_spo2: 'Your oxygen reading looks lower than usual. Please sit upright. Are you finding it hard to breathe?',
  q_manual: 'I am listening. How are you feeling?',
  test_voice: 'Hello. This is how I will sound through your headset.',
  ack_fine: 'I am glad you are alright.',
  offer_breathing: 'Would you like me to guide your breathing?',
  offer_alert: 'Shall I prepare a message to your caregiver?',
  unclear: 'Sorry, I did not catch that. Could you say it again?',
};

const KEYS: MetricKey[] = ['hr', 'spo2', 'temp'];
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const emptyHist = (): Record<MetricKey, Sample[]> => ({ hr: [], spo2: [], temp: [] });

export function useVoiceAgent(opts: VoiceAgentOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [status, setStatus] = useState<AgentStatus>('off');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const [lastTrigger, setLastTrigger] = useState<Trigger | null>(null);
  const [pendingAlert, setPendingAlert] = useState<{ url: string; name: string } | null>(null);
  const [sim, setSim] = useState<SimKind>(null);
  const [sensitivity, setSensitivity] = useState<Sensitivity>(() => loadSensitivity());

  const activeRef = useRef(false);
  const busyRef = useRef(false);
  const speakerRef = useRef<Speaker | null>(null);
  if (!speakerRef.current) speakerRef.current = new Speaker();
  const listenerRef = useRef<Listener | null>(null);
  const phrasesRef = useRef<Phrases>(FALLBACK_PHRASES);
  const logId = useRef(0);

  const hist = useRef(emptyHist());
  const latest = useRef<Partial<Record<MetricKey, Sample>>>({});
  const lastHistorySampleAt = useRef<Record<MetricKey, number>>({ hr: 0, spo2: 0, temp: 0 });
  const baselines = useRef<Baselines>(loadBaselines());
  const sens = useRef<Sensitivity>(sensitivity);
  const analysisRef = useRef<Analysis | null>(null);
  const simRef = useRef<{ kind: Exclude<SimKind, null>; start: number } | null>(null);
  const lastBaseAt = useRef<Partial<Record<MetricKey, number>>>({});
  const lastSave = useRef(0);
  const lastTopicAt = useRef<Partial<Record<string, number>>>({});
  const lastConvoEnd = useRef(0);
  const rot = useRef({ idx: -1, until: 0, cmd: '' });

  const P = (key: string) => phrasesRef.current[key] ?? FALLBACK_PHRASES[key] ?? '';
  const addLog = useCallback((who: LogEntry['who'], text: string, reason?: string) => {
    setLog((l) => [...l.slice(-60), { id: ++logId.current, t: Date.now(), who, text, reason }]);
  }, []);

  const say = async (text: string) => {
    if (!text) return;
    setStatus('speaking');
    const o = optsRef.current;
    setEngine(await speakerRef.current!.speak(text, o.language, o.speechCode));
  };

  const hear = async (): Promise<string | null> => {
    setStatus('listening');
    const l = listenOnce(optsRef.current.speechCode);
    listenerRef.current = l;
    const text = await l.promise;
    listenerRef.current = null;
    return text;
  };

  // ---------------------------------------------------------- live ESP32 feed ---
  // The scan workflow uses MAX30102 pulse/SpO₂ and MAX30205 body temperature.
  const ingest = (sensorName: string, d: Record<string, any>, t: number) => {
    const sensor = sensorName.toLowerCase();
    const model = String(d.sensor_model ?? '').toUpperCase();
    const pulseSample = sensor.includes('max30102') || d.finger_detected === true;
    if (pulseSample && d.finger_detected === true) {
      if (d.heart_rate_valid === true) {
        const hr = Number(d.heart_rate);
        if (Number.isFinite(hr) && hr > 30 && hr < 200) latest.current.hr = { t, v: hr };
      }
      if (d.spo2_valid === true) {
        const spo2 = Number(d.spo2);
        if (Number.isFinite(spo2) && spo2 > 70 && spo2 <= 100) latest.current.spo2 = { t, v: spo2 };
      }
    } else if (model === 'MAX30205' && d.valid === true) {
      const temp = Number(d.temperature);
      if (Number.isFinite(temp) && temp > 34 && temp < 43) latest.current.temp = { t, v: temp };
    }
  };
  const feed = useDeviceFeed(ingest);

  const feedRef = useRef(feed);
  feedRef.current = feed;

  // ------------------------------------------------------------ conversation ---
  const currentFacts = () => {
    const m = analysisRef.current?.metrics;
    if (!m) return 'no recent readings';
    const parts: string[] = [];
    if (m.hr.recent !== null) parts.push(`heart rate ${m.hr.recent.toFixed(0)} bpm`);
    if (m.temp.recent !== null) parts.push(`body temperature ${m.temp.recent.toFixed(1)} C`);
    if (m.spo2.recent !== null) parts.push(`SpO2 ${m.spo2.recent.toFixed(0)}%`);
    return parts.join(', ') || 'no recent readings';
  };

  const guideBreathing = async () => {
    addLog('system', 'Guided breathing: 3 slow cycles');
    for (let i = 0; i < 3 && activeRef.current; i++) {
      await say(P('breathe_in')); await wait(2500);
      await say(P('hold')); await wait(2000);
      await say(P('breathe_out')); await wait(3500);
    }
    if (activeRef.current) await say(P('breathing_done'));
  };

  const prepareAlert = async (facts: string) => {
    const o = optsRef.current;
    const digits = o.caregiver.phone.replace(/\D/g, '');
    if (digits.length < 10) { addLog('system', 'No caregiver number set'); await say(P('no_caregiver')); return; }
    const phone = digits.length === 10 ? `91${digits}` : digits;
    const name = o.caregiver.name.trim() || 'your caregiver';
    const msg = `Jeevan Voice Agent: ${o.person} may need a check-in (${facts}). Time ${new Date().toLocaleTimeString()}. They asked for help.`;
    setPendingAlert({ url: `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, name });
    addLog('system', `Message to ${name} prepared - waiting for you to tap Send`);
    await say(P('alert_prepared').replace('{name}', name));
  };

  const localReply = (heard: string, pending: string, topic: string): ConverseResult => {
    if (pending !== 'none') return { reply: '', intent: localYesNo(heard), offer: 'none' };
    const intent = localIntent(heard);
    if (intent === 'help') return { reply: P('offer_alert'), intent, offer: 'alert' };
    if (intent === 'unwell') {
      const stress = ['nervous', 'rising_hr', 'manual'].includes(topic);
      return { reply: stress ? P('offer_breathing') : P('check_again'), intent, offer: stress ? 'breathing' : 'none' };
    }
    if (intent === 'fine') return { reply: P('ack_fine'), intent, offer: 'none' };
    return { reply: P('unclear'), intent, offer: 'none' };
  };

  const proactivePhrases = [
    "I am keeping an eye on your vitals. Everything looks steady right now.",
    "Your readings are looking stable. Remember to take a slow, gentle breath.",
    "I am right here with you. Feel free to talk to me whenever you want.",
    "Your heart rate and readings look calm. Are you feeling alright?",
    "I am keeping a continuous watch on you. Are you feeling comfortable?",
  ];
  const proactiveIdx = useRef(0);

  // -------------------------------------------------------------------- tick ---
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const o = optsRef.current;
      const simState = simRef.current;

      // 1) collect samples (real sensors, or the clearly-labelled rehearsal generator)
      if (simState) {
        const el = (now - simState.start) / 1000;
        const eb = (k: MetricKey) => effectiveBaseline(baselines.current[k], k).mean;
        const j = (x: number) => (Math.random() - 0.5) * 2 * x;
        const hrV = simState.kind === 'nervous' ? eb('hr') + Math.min(35, el * 0.7) + j(1.5)
          : simState.kind === 'fever' ? eb('hr') + Math.min(10, el * 0.1) + j(1.5) : eb('hr') + j(1.5);
        const tV = simState.kind === 'fever' ? eb('temp') + Math.min(1.4, el * 0.025) + j(0.03) : eb('temp') + j(0.04);
        latest.current = { hr: { t: now, v: hrV }, temp: { t: now, v: tV }, spo2: { t: now, v: 97 + j(0.5) } };
      }
      KEYS.forEach((k) => {
        const l = latest.current[k];
        if (l && now - l.t < 8000 && l.t > lastHistorySampleAt.current[k]) {
          hist.current[k].push(l);
          lastHistorySampleAt.current[k] = l.t;
          hist.current[k] = hist.current[k].filter((s) => now - s.t <= 150_000);
        }
      });

      // 2) learn the personal baseline (skipped for simulated data and clearly abnormal readings)
      if (!simState) {
        KEYS.forEach((k) => {
          const arr = hist.current[k];
          const last = arr[arr.length - 1];
          if (!last || now - last.t > 4000 || now - (lastBaseAt.current[k] ?? 0) < 3000) return;
          const eb = effectiveBaseline(baselines.current[k], k);
          if (eb.n < 10 || Math.abs((last.v - eb.mean) / eb.sd) < 2) {
            baselines.current[k] = updateBaseline(baselines.current[k], k, last.v);
          }
          lastBaseAt.current[k] = now;
        });
        if (now - lastSave.current > 15_000) { saveBaselines(baselines.current); lastSave.current = now; }
      }

      // 3) analyse + forecast
      const a = analyze(hist.current, baselines.current, now);
      analysisRef.current = a;
      setAnalysis(a);

      if (!activeRef.current) return;

      // 4) which ESP32 sensor to stream (existing firmware, unchanged)
      if (o.rotate === 'auto') {
        if (now >= rot.current.until) {
          rot.current.idx = (rot.current.idx + 1) % 2;
          rot.current.cmd = rot.current.idx === 0 ? 'read_max30102' : 'read_dht11';
          rot.current.until = now + (rot.current.idx === 0 ? 25_000 : 12_000);
          void feedRef.current.sendCommand(rot.current.cmd);
        }
      } else {
        const cmd = o.rotate === 'hr' ? 'read_max30102' : 'read_dht11';
        if (rot.current.cmd !== cmd) { rot.current.cmd = cmd; void feedRef.current.sendCommand(cmd); }
      }
    };
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------------------------------------------------------- actions ---
  const start = useCallback(async () => {
    if (activeRef.current) return;
    activeRef.current = true;
    rot.current = { idx: -1, until: 0, cmd: '' };
    busyRef.current = true;

    try {
      const p = await fetchPhrases(optsRef.current.language);
      phrasesRef.current = { ...FALLBACK_PHRASES, ...(p ?? {}) };
    } catch {
      phrasesRef.current = FALLBACK_PHRASES;
    }

    addLog('system', 'Voice agent started');

    // First message MUST BE: "Hi, I am there to help you."
    const greetingText = P('greeting') || 'Hi, I am there to help you.';
    addLog('agent', greetingText, 'Opening greeting');
    await say(greetingText);

    // Continuous conversation & monitoring loop until user presses Stop
    const history: Turn[] = [{ role: 'agent', text: greetingText }];
    let pending: 'none' | 'breathing' | 'alert' = 'none';

    while (activeRef.current) {
      try {
        // Listen for 5 seconds of silence
        setStatus('listening');
        const heard = await hear();
        if (!activeRef.current) break;

        if (heard && heard.trim()) {
          // User spoke something!
          addLog('user', heard);
          history.push({ role: 'user', text: heard });
          setStatus('thinking');
          const o = optsRef.current;
          const facts = currentFacts();
          let res: ConverseResult;
          try {
            res = await fetchConverse({
              language: o.language,
              topic: 'monitoring',
              facts,
              history,
              user_text: heard,
              pending_offer: pending,
            });
          } catch {
            res = localReply(heard, pending, 'monitoring');
          }

          if (res.intent === 'help' && res.offer === 'none' && pending === 'none') {
            res = { ...res, offer: 'alert', reply: res.reply || P('offer_alert') };
          }

          if (res.reply) {
            addLog('agent', res.reply);
            history.push({ role: 'agent', text: res.reply });
            await say(res.reply);
          }

          if (pending !== 'none') {
            if (res.intent === 'yes') {
              if (pending === 'breathing') await guideBreathing();
              else await prepareAlert(facts);
            } else if (res.intent === 'no' && !res.reply) {
              await say(P('stay_nearby'));
            }
            pending = 'none';
          } else if (res.offer !== 'none') {
            pending = res.offer;
          }
        } else {
          // 5 seconds of silence: AI automatically speaks
          if (!activeRef.current) break;

          const a = analysisRef.current;
          const trg = a ? detectTrigger(a, sens.current, { relaxLearning: !!simRef.current }) : null;
          let proactiveLine = '';

          if (trg) {
            setLastTrigger(trg);
            try {
              const o = optsRef.current;
              proactiveLine = (await fetchQuestion({
                language: o.language,
                topic: trg.topic,
                facts: trg.facts || currentFacts(),
                severity: trg.severity,
                person: o.person,
              })).text;
            } catch {
              proactiveLine = P(`q_${trg.topic}`) || 'I noticed a change in your vitals. Are you feeling alright?';
            }
            addLog('agent', proactiveLine, `Vitals forecast: ${trg.topic}`);
          } else {
            proactiveLine = proactivePhrases[proactiveIdx.current % proactivePhrases.length];
            proactiveIdx.current++;
            addLog('agent', proactiveLine, 'Automatic check-in after 5s silence');
          }

          history.push({ role: 'agent', text: proactiveLine });
          await say(proactiveLine);
        }
      } catch (err) {
        console.warn('Voice agent loop cycle notice:', err);
        await wait(600);
      }
    }

    busyRef.current = false;
    setStatus('off');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    busyRef.current = false;
    listenerRef.current?.cancel();
    speakerRef.current?.stop();
    rot.current = { idx: -1, until: 0, cmd: '' };
    await feedRef.current.sendCommand('idle');
    setStatus('off');
    addLog('system', 'Voice agent stopped');
  }, [addLog]);

  const askNow = useCallback(() => {}, []);

  const testVoice = useCallback(async () => {
    const o = optsRef.current;
    const p = await fetchPhrases(o.language);
    phrasesRef.current = { ...FALLBACK_PHRASES, ...(p ?? {}) };
    setEngine(await speakerRef.current!.speak(P('test_voice'), o.language, o.speechCode));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOutputDevice = useCallback((id: string) => { speakerRef.current!.sinkId = id; }, []);

  const simulate = useCallback((kind: SimKind) => {
    simRef.current = kind ? { kind, start: Date.now() } : null;
    if (!kind) latest.current = {};
    setSim(kind);
    addLog('system', kind ? `Rehearsal mode: simulated "${kind}" readings (not from the sensors)` : 'Rehearsal mode off');
  }, [addLog]);

  const resetLearning = useCallback(() => {
    baselines.current = {}; sens.current = {}; hist.current = emptyHist();
    lastHistorySampleAt.current = { hr: 0, spo2: 0, temp: 0 };
    saveBaselines({}); saveSensitivity({}); setSensitivity({});
    addLog('system', 'Learned baseline cleared - starting to learn again');
  }, [addLog]);

  useEffect(() => () => {
    activeRef.current = false;
    listenerRef.current?.cancel();
    speakerRef.current?.stop();
    saveBaselines(baselines.current);
  }, []);

  return {
    status, log, analysis, engine, lastTrigger, pendingAlert, sim, sensitivity, feed,
    start, stop, askNow, testVoice, setOutputDevice, simulate, resetLearning,
    dismissAlert: () => setPendingAlert(null),
  };
}

export type { TriggerTopic };


