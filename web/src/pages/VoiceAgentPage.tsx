import { useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceAgent, type RotateMode, type SimKind } from '../hooks/useVoiceAgent';
import { useSensorWorkflow, type ScanSensor } from '../hooks/useSensorWorkflow';
import { SensorWorkflowPanel } from '../components/SensorWorkflowPanel';
import { MedicineReminderPanel } from '../components/MedicineReminderPanel';
import { METRIC_LABEL, METRIC_UNIT, type MetricKey, type MetricView } from '../lib/anticipation';
import { voiceHealth, type VoiceHealth } from '../lib/voiceClient';

const LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', speechCode: 'en-IN' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', speechCode: 'hi-IN' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', speechCode: 'kn-IN' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', speechCode: 'ta-IN' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', speechCode: 'te-IN' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', speechCode: 'ml-IN' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', speechCode: 'bn-IN' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', speechCode: 'mr-IN' },
];
const CG_KEY = 'jeevan_voice_caregiver_v1';

const card: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 18, padding: 18,
  boxShadow: '0 2px 10px rgba(15,23,42,0.04)',
};
const label: React.CSSProperties = {
  margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase',
};
const input: React.CSSProperties = {
  width: '100%', padding: '9px 11px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 14, background: '#fff', boxSizing: 'border-box',
};

const STATUS_STYLE: Record<string, { bg: string; fg: string; text: string }> = {
  off: { bg: '#f1f5f9', fg: '#64748b', text: 'Off' },
  monitoring: { bg: '#ecfdf5', fg: '#047857', text: 'Watching & learning' },
  speaking: { bg: '#eff6ff', fg: '#1d4ed8', text: 'Speaking' },
  listening: { bg: '#fff7ed', fg: '#c2410c', text: 'Listening to you' },
  thinking: { bg: '#faf5ff', fg: '#7e22ce', text: 'Thinking' },
};

function Spark({ view, color }: { view: MetricView; color: string }) {
  const h = view.history;
  if (h.length < 2) return <div style={{ height: 36 }} />;
  const vs = h.map((s) => s.v);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const pts = h.map((s, i) => `${(i / (h.length - 1)) * 100},${34 - ((s.v - lo) / span) * 30}`).join(' ');
  return (
    <svg viewBox="0 0 100 36" preserveAspectRatio="none" style={{ width: '100%', height: 36 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function VitalCard({ k, v, color }: { k: MetricKey; v: MetricView; color: string }) {
  const decimals = k === 'temp' ? 1 : 0;
  const worse = v.z === null ? 0 : k === 'spo2' ? -v.z : v.z;
  const tone = worse >= 2 ? '#dc2626' : worse >= 1 ? '#d97706' : '#059669';
  return (
    <div style={card}>
      <p style={label}>{METRIC_LABEL[k]}</p>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 34, fontWeight: 800, color: v.value === null ? '#cbd5e1' : '#0f172a' }}>
          {v.value === null ? '--' : v.value.toFixed(decimals)}
        </span>
        <span style={{ fontSize: 13, color: '#64748b' }}>{METRIC_UNIT[k]}</span>
        {v.z !== null && <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: tone }}>{v.z >= 0 ? '+' : ''}{v.z.toFixed(1)}σ</span>}
      </div>
      <Spark view={v} color={color} />
      <p style={{ margin: '6px 0 0', fontSize: 12, color: '#64748b' }}>
        Your usual: {v.baseline.mean.toFixed(decimals)} ± {v.baseline.sd.toFixed(k === 'temp' ? 2 : 1)} · learned {Math.round(v.baseline.learned * 100)}%
      </p>
      <p style={{ margin: '4px 0 0', fontSize: 12, fontWeight: 600, color: v.etaSec !== null ? '#c2410c' : '#94a3b8' }}>
        {v.etaSec !== null
          ? `Forecast: reaches ${v.target.toFixed(decimals)} in ~${v.etaSec < 90 ? `${Math.round(v.etaSec)} s` : `${(v.etaSec / 60).toFixed(1)} min`} (${Math.round(v.confidence * 100)}% sure)`
          : v.fresh ? 'Forecast: steady' : 'Waiting for sensor…'}
      </p>
    </div>
  );
}

export default function VoiceAgentPage() {
  // The ESP32 (VitaWatch hardware) feed is handled inside useVoiceAgent -> agent.feed.

  const [language, setLanguage] = useState('en');
  const [rotate, setRotate] = useState<RotateMode>('auto');
  const [caregiver, setCaregiver] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CG_KEY) || '') as { person: string; name: string; phone: string }; } catch { return { person: '', name: '', phone: '' }; }
  });
  const [health, setHealth] = useState<VoiceHealth | null | undefined>(undefined);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now());
  const feedRef = useRef<HTMLDivElement>(null);

  const speechCode = useMemo(
    () => LANGUAGES.find((l) => l.code === language)?.speechCode || 'en-IN', [language]);
  const person = caregiver.person.trim() || 'the wearer';

  const agent = useVoiceAgent({ language, speechCode, person, caregiver, rotate });
  const workflow = useSensorWorkflow({
    metrics: agent.analysis?.metrics ?? null,
    status: agent.feed.status,
    sendCommand: agent.feed.sendCommand,
    beforeSensorCommand: async () => { if (agent.status !== 'off') await agent.stop(); },
  });

  useEffect(() => { try { localStorage.setItem(CG_KEY, JSON.stringify(caregiver)); } catch { /* ignore */ } }, [caregiver]);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(i); }, []);
  useEffect(() => {
    let alive = true;
    const check = async () => { const h = await voiceHealth(); if (alive) setHealth(h); };
    void check();
    const i = setInterval(check, 10_000);
    return () => { alive = false; clearInterval(i); };
  }, []);
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' }); }, [agent.log.length]);

  const refreshDevices = async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setOutputs(devs.filter((d) => d.kind === 'audiooutput'));
      setInputs(devs.filter((d) => d.kind === 'audioinput'));
    } catch { /* ignore */ }
  };
  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, []);

  useEffect(() => {
    // If mic permission is already granted, auto-start immediately
    if (typeof navigator !== 'undefined' && 'mediaDevices' in navigator) {
      navigator.permissions?.query?.({ name: 'microphone' as PermissionName })
        .then((perm) => {
          if (perm.state === 'granted') {
            setMicOk(true);
            void agent.start();
          }
          perm.onchange = () => {
            if (perm.state === 'granted') {
              setMicOk(true);
              void agent.start();
            }
          };
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allowMic = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicOk(true);
      await refreshDevices();
    } catch { setMicOk(false); }
  };

  const handleStart = async () => {
    if (micOk === null) await allowMic();
    await agent.start();
  };

  const ds = agent.feed.status;
  const secondsAgo = ds && ds.updated_at ? Math.max(0, Math.floor((now - ds.updated_at) / 1000)) : null;
  const esp32Online = !!ds?.online;
  const st = STATUS_STYLE[agent.status];
  const running = agent.status !== 'off';
  const a = agent.analysis;
  const btHint = [...outputs, ...inputs].some((d) => /bluetooth|headset|buds|airpods|hands-free/i.test(d.label));
  const riskColor = (r: number) => (r >= 60 ? '#dc2626' : r >= 30 ? '#d97706' : '#059669');
  const dot = (ok: boolean | null) => (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6, background: ok ? '#10b981' : ok === null ? '#cbd5e1' : '#ef4444' }} />
  );

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px 80px' }}>
      {/* Header */}
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#0f172a', fontFamily: "'Space Grotesk', sans-serif" }}>🎧 Voice Agent</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            Continuous proactive companion · Speaks first · Auto-speaks on 5s silence
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ padding: '7px 14px', borderRadius: 999, background: st.bg, color: st.fg, fontWeight: 700, fontSize: 13 }}>● {st.text}</span>
          {running ? (
            <button type="button" onClick={agent.stop}
              style={{ padding: '10px 24px', borderRadius: 12, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer', boxShadow: '0 2px 8px rgba(220,38,38,0.3)' }}>■ Stop</button>
          ) : (
            <button type="button" onClick={handleStart}
              style={{ padding: '12px 26px', borderRadius: 12, border: 'none', background: '#0d9488', color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', boxShadow: '0 2px 8px rgba(13,148,136,0.3)' }}>▶ Start Voice Agent</button>
          )}
        </div>
      </div>

      {/* Connections */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div style={card}><p style={label}>ESP32 (VitaWatch)</p>
          <b style={{ fontSize: 14, color: esp32Online ? '#059669' : '#dc2626' }}>{dot(esp32Online)}{esp32Online ? `Connected · ${secondsAgo}s ago` : ds && !ds.reachable ? 'Cloud endpoint unreachable' : 'Device offline'}</b>
        </div>
        <div style={card}><p style={label}>Voice service (Python)</p>
          <b style={{ fontSize: 14, color: health ? '#059669' : '#dc2626' }}>{dot(health ? true : health === undefined ? null : false)}{health ? 'Running' : health === undefined ? 'Checking…' : 'Not running (port 8001)'}</b>
          {health && <p style={{ margin: '6px 0 0', fontSize: 12, color: '#64748b' }}>{dot(health.elevenlabs)}ElevenLabs &nbsp; {dot(health.gemini)}Gemini</p>}
        </div>
        <div style={card}><p style={label}>Voice</p>
          <b style={{ fontSize: 14 }}>{agent.engine === 'elevenlabs' ? '🟢 ElevenLabs' : agent.engine === 'browser-fallback' ? '🟠 Browser fallback voice' : agent.engine === 'blocked' ? '🔴 Audio blocked' : '—'}</b>
        </div>
        <div style={card}><p style={label}>Headset mic</p>
          <b style={{ fontSize: 14 }}>{dot(micOk)}{micOk ? 'Allowed' : micOk === false ? 'Blocked' : 'Not asked yet'}</b>
        </div>
      </div>

      <MedicineReminderPanel
        speechCode={speechCode}
        onBeforeVoiceInput={async () => { if (agent.status !== 'off') await agent.stop(); }}
      />

      <SensorWorkflowPanel
        workflow={workflow}
        status={ds}
        canCommand={!!ds?.can_command}
        voiceRunning={running}
        onFullScan={() => void workflow.startFullScan()}
        onSelectSensor={(sensor: ScanSensor) => void workflow.startSensor(sensor)}
      />

      {/* Vitals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14, marginBottom: 20 }}>
        {a && (['hr', 'spo2', 'temp'] as MetricKey[]).map((k, i) =>
          <VitalCard key={k} k={k} v={a.metrics[k]} color={['#e11d48', '#0284c7', '#d97706'][i]} />)}
      </div>

      {/* Risk */}
      <div style={{ ...card, marginBottom: 20 }}>
        <p style={label}>Early-warning risk (not a diagnosis)</p>
        {a && (
          <>
            <div style={{ position: 'relative', height: 14, borderRadius: 8, background: '#f1f5f9', overflow: 'hidden' }}>
              <div style={{ width: `${a.risk}%`, height: '100%', background: riskColor(a.risk), transition: 'width .6s' }} />
              <div style={{ position: 'absolute', top: 0, left: `${a.riskIn60}%`, width: 3, height: '100%', background: '#0f172a' }} title="Forecast in 60 s" />
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#334155' }}>
              Now <b style={{ color: riskColor(a.risk) }}>{Math.round(a.risk)}</b> · in 60 s <b>{Math.round(a.riskIn60)}</b> (black marker) ·
              baseline learned <b>{Math.round(a.learned * 100)}%</b>
              {a.learned < 0.3 && ' — still learning what is normal for you, so I will stay quiet for subtle changes.'}
            </p>
          </>
        )}
        {agent.lastTrigger && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#7c2d12', background: '#fff7ed', padding: '8px 12px', borderRadius: 10 }}>
            Last reason I spoke: {agent.lastTrigger.reason} · {Math.round(agent.lastTrigger.confidence * 100)}% sure
          </p>
        )}
      </div>

      {agent.pendingAlert && (
        <div style={{ ...card, marginBottom: 20, borderColor: '#fca5a5', background: '#fef2f2' }}>
          <b style={{ color: '#991b1b' }}>Message to {agent.pendingAlert.name} is ready.</b>
          <p style={{ margin: '6px 0 12px', fontSize: 13, color: '#7f1d1d' }}>Nothing is sent until you tap the button.</p>
          <a href={agent.pendingAlert.url} target="_blank" rel="noreferrer" onClick={agent.dismissAlert}
            style={{ padding: '10px 18px', borderRadius: 10, background: '#16a34a', color: '#fff', fontWeight: 700, textDecoration: 'none', marginRight: 10 }}>Send on WhatsApp</a>
          <button type="button" onClick={agent.dismissAlert} style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {/* Conversation */}
        <div style={card}>
          <p style={label}>Conversation</p>
          <div ref={feedRef} style={{ height: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {agent.log.length === 0 && <p style={{ color: '#94a3b8', fontSize: 13 }}>Press Start. When the forecast says something is coming, I will speak first — you only need to answer.</p>}
            {agent.log.map((e) => (
              <div key={e.id} style={{ alignSelf: e.who === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
                {e.who === 'system'
                  ? <div style={{ fontSize: 12, color: '#64748b', fontStyle: 'italic' }}>{e.text}</div>
                  : <div style={{ padding: '9px 13px', borderRadius: 14, background: e.who === 'agent' ? '#ecfeff' : '#f1f5f9', fontSize: 14, color: '#0f172a' }}>
                      {e.text}
                      {e.reason && <div style={{ marginTop: 5, fontSize: 11, color: '#0e7490' }}>why: {e.reason}</div>}
                    </div>}
              </div>
            ))}
          </div>
        </div>

        {/* Settings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={card}>
            <p style={label}>Headset & language</p>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ ...input, marginBottom: 10 }} disabled={running}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.nativeName} ({l.name})</option>)}
            </select>
            <select onChange={(e) => agent.setOutputDevice(e.target.value)} style={{ ...input, marginBottom: 8 }}>
              <option value="">Default speaker</option>
              {outputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio output'}</option>)}
            </select>
            <button type="button" onClick={agent.testVoice} style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontWeight: 600 }}>🔊 Test voice</button>
            <button type="button" onClick={allowMic} style={{ marginLeft: 8, padding: '8px 14px', borderRadius: 10, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontWeight: 600 }}>🎙 Allow mic</button>
            <p style={{ margin: '10px 0 0', fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
              Pair the headset in Windows, then set it as the default <b>input</b> and <b>output</b> (the browser can only choose the output here).
              {btHint ? ' ✔ Bluetooth headset detected.' : ' No Bluetooth headset detected yet.'}
            </p>
          </div>

          <div style={card}>
            <p style={label}>Voice monitoring sensor (continuous mode)</p>
            <select value={rotate} onChange={(e) => setRotate(e.target.value as RotateMode)} style={input}>
              <option value="auto">Auto: pulse/SpO₂ 25 s → temperature 12 s</option>
              <option value="hr">Hold pulse / SpO₂ (finger on MAX30102)</option>
              <option value="temp">Hold body temperature (MAX30205)</option>
            </select>
            <p style={{ margin: '12px 0 6px', ...label }}>Caregiver (asked before anything is sent)</p>
            <input style={{ ...input, marginBottom: 8 }} placeholder="Person I am looking after (e.g. Appa)" value={caregiver.person} onChange={(e) => setCaregiver({ ...caregiver, person: e.target.value })} />
            <input style={{ ...input, marginBottom: 8 }} placeholder="Caregiver name (e.g. Priya)" value={caregiver.name} onChange={(e) => setCaregiver({ ...caregiver, name: e.target.value })} />
            <input style={input} placeholder="WhatsApp number" value={caregiver.phone} onChange={(e) => setCaregiver({ ...caregiver, phone: e.target.value })} />
          </div>

          <div style={card}>
            <p style={label}>Rehearsal (simulated readings — not real sensors)</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {(['calm', 'nervous', 'fever'] as Exclude<SimKind, null>[]).map((k) => (
                <button key={k} type="button" onClick={() => agent.simulate(agent.sim === k ? null : k)}
                  style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid #cbd5e1', cursor: 'pointer', fontWeight: 600,
                    background: agent.sim === k ? '#0f172a' : '#fff', color: agent.sim === k ? '#fff' : '#0f172a' }}>{k}</button>
              ))}
              <button type="button" onClick={agent.resetLearning} style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', cursor: 'pointer', fontWeight: 600 }}>Reset learning</button>
            </div>
            {agent.sim && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b45309' }}>⚠ Simulated data is active. Turn it off for the real demo.</p>}
          </div>
        </div>
      </div>
      {ds && !ds.can_command && <p style={{ marginTop: 14, fontSize: 13, color: '#b45309' }}>Sensor switching is off: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to server/.env. Until then I use whichever sensor is already streaming.</p>}
    </div>
  );
}


