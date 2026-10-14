import type { StickEvent, StickStatus } from '../hooks/useStickFeed';
import type { VoiceEngine } from '../lib/voiceClient';

const panel: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 18, padding: 18,
  boxShadow: '0 2px 10px rgba(15,23,42,0.04)', marginBottom: 20,
};
const label: React.CSSProperties = {
  margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '0.05em', textTransform: 'uppercase',
};
const tile: React.CSSProperties = {
  border: '1px solid #e2e8f0', borderRadius: 14, padding: 12, background: '#f8fafc',
};

function distanceText(cm: unknown, contact: unknown) {
  if (contact === true || cm === 0) return { text: 'TOUCHING', color: '#dc2626' };
  if (typeof cm !== 'number' || cm < 0) return { text: 'clear', color: '#059669' };
  return { text: `${cm} cm`, color: cm <= 35 ? '#dc2626' : cm <= 80 ? '#d97706' : '#059669' };
}

export function WalkingStickPanel({
  status, events, engine, voiceEnabled, onToggleVoice,
}: {
  status: StickStatus | null;
  events: StickEvent[];
  engine: VoiceEngine | null;
  voiceEnabled: boolean;
  onToggleVoice: (on: boolean) => void;
}) {
  const d = status?.data ?? {};
  const online = !!status?.online;
  const lightOn = d.light_on === true;
  const sides: { key: 'left' | 'front' | 'right'; name: string }[] = [
    { key: 'left', name: 'Left · Sensor 1' },
    { key: 'front', name: 'Front · Sensor 2' },
    { key: 'right', name: 'Right · Sensor 3' },
  ];
  const recent = events.slice(-6).reverse();

  return (
    <div style={panel}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div>
          <p style={label}>ESP32 #2 · Walking stick (ultrasonic guidance + LDR light)</p>
          <b style={{ fontSize: 14, color: online ? '#059669' : '#dc2626' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6, background: online ? '#10b981' : '#ef4444' }} />
            {online ? `Connected · ${Math.round((status?.age_ms ?? 0) / 1000)}s ago` : 'Stick offline (power it and check Wi-Fi / laptop IP)'}
          </b>
        </div>
        <button type="button" onClick={() => onToggleVoice(!voiceEnabled)}
          style={{ padding: '9px 16px', borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14,
            background: voiceEnabled ? '#0d9488' : '#e2e8f0', color: voiceEnabled ? '#fff' : '#334155' }}>
          {voiceEnabled ? '🔊 Stick voice ON' : '🔇 Stick voice OFF'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {sides.map((s) => {
          const v = distanceText(d[`${s.key}_cm`], d[`${s.key}_contact`]);
          return (
            <div key={s.key} style={tile}>
              <p style={label}>{s.name}</p>
              <b style={{ fontSize: 22, color: online ? v.color : '#cbd5e1' }}>{online ? v.text : '--'}</b>
            </div>
          );
        })}
        <div style={{ ...tile, background: lightOn ? '#fefce8' : '#f8fafc', borderColor: lightOn ? '#facc15' : '#e2e8f0' }}>
          <p style={label}>Automatic light (GPIO 2)</p>
          <b style={{ fontSize: 22, color: online ? (lightOn ? '#ca8a04' : '#334155') : '#cbd5e1' }}>
            {online ? (lightOn ? '💡 ON (dark)' : 'OFF (bright)') : '--'}
          </b>
          {online && (
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>
              LDR {d.ldr_avg ?? '--'} · threshold {d.ldr_threshold ?? '--'} ± {d.ldr_hysteresis ?? '--'}
            </p>
          )}
        </div>
      </div>

      <p style={{ ...label, marginTop: 14 }}>What the agent said</p>
      {recent.length === 0
        ? <p style={{ margin: 0, fontSize: 13, color: '#94a3b8' }}>Waiting for the stick… obstacle and light messages will be spoken here.</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recent.map((e) => (
              <div key={e.id} style={{ fontSize: 13, padding: '7px 11px', borderRadius: 10,
                background: e.priority >= 3 ? '#fef2f2' : e.source === 'light' ? '#fefce8' : '#ecfeff',
                color: '#0f172a' }}>
                <span style={{ color: '#64748b', marginRight: 8 }}>{new Date(e.received_at).toLocaleTimeString()}</span>
                {e.source === 'light' ? '💡 ' : '🦯 '}{e.message}
              </div>
            ))}
          </div>
        )}
      {voiceEnabled && engine === 'blocked' && (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: '#b45309' }}>
          The browser blocked audio. Click “Stick voice” off and on once to allow speech.
        </p>
      )}
    </div>
  );
}
