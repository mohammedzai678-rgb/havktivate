import type { DeviceStatus } from '../hooks/useDeviceFeed';
import type { ScanSensor } from '../hooks/useSensorWorkflow';

type Workflow = ReturnType<typeof import('../hooks/useSensorWorkflow').useSensorWorkflow>;

const panel: React.CSSProperties = {
  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 18, padding: 18,
  boxShadow: '0 2px 10px rgba(15,23,42,0.04)',
};
const buttonBase: React.CSSProperties = {
  borderRadius: 12, border: '1px solid #cbd5e1', padding: '11px 14px',
  background: '#fff', color: '#334155', fontWeight: 700, fontSize: 14, cursor: 'pointer',
};
const mutedButton: React.CSSProperties = { ...buttonBase, opacity: 0.5, cursor: 'not-allowed' };
const sensorNames: Record<ScanSensor, string> = {
  max30102: 'MAX30102 · Pulse / SpO₂',
  max30205: 'MAX30205 · Temperature',
};

function detectedSensor(status: DeviceStatus | null): ScanSensor | null {
  const label = (String(status?.sensor ?? '') + ' ' + String(status?.data?.sensor_model ?? '')).toLowerCase();
  if (label.includes('max30102') || status?.data?.finger_detected === true) return 'max30102';
  if (label.includes('max30205')) return 'max30205';
  return null;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SensorWorkflowPanel({
  workflow, status, canCommand, voiceRunning, onFullScan, onSelectSensor,
}: {
  workflow: Workflow;
  status: DeviceStatus | null;
  canCommand: boolean;
  voiceRunning: boolean;
  onFullScan: () => void;
  onSelectSensor: (sensor: ScanSensor) => void;
}) {
  const stale = !status?.online || status.age_ms >= 10_000;
  const selectedName = workflow.activeSensor ? sensorNames[workflow.activeSensor] : '';
  const detected = detectedSensor(status);
  const disabled = workflow.isSendingCommand || !canCommand;
  const currentValue = workflow.activeSensor === 'max30102'
    ? workflow.captured.heart_rate === null ? 'Waiting for a valid pulse…' : workflow.captured.heart_rate + ' bpm'
    : workflow.activeSensor === 'max30205'
      ? workflow.captured.temperature === null ? 'Waiting for temperature…' : workflow.captured.temperature.toFixed(1) + ' °C'
      : 'No sensor active. Select a sensor or start Full Scan.';

  return (
    <section style={{ ...panel, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19, color: '#0f172a' }}>Sensor scan & readings</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>Scan pulse/SpO₂, then temperature. Save readings and manage history here.</p>
        </div>
        <span style={{ padding: '7px 11px', borderRadius: 999, background: stale ? '#fef2f2' : '#ecfdf5', color: stale ? '#b91c1c' : '#047857', fontSize: 12, fontWeight: 700 }}>
          {stale ? 'Device offline · waiting for fresh telemetry' : 'Device connected'}
        </span>
      </div>

      {stale && (
        <div role="status" style={{ marginTop: 14, padding: '12px 14px', border: '1px solid #fecaca', borderRadius: 12, background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>
          No recent telemetry from the ESP32. Check its power, Wi-Fi connection, and server endpoint.
        </div>
      )}

      {voiceRunning && (
        <p style={{ margin: '12px 0 0', padding: '10px 12px', borderRadius: 10, background: '#eff6ff', color: '#1d4ed8', fontSize: 13 }}>
          Starting a manual scan pauses Voice Agent so it will not change sensors during the scan.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 14 }}>
        <button type="button" onClick={onFullScan} disabled={disabled}
          style={{ ...buttonBase, minWidth: 210, background: disabled ? '#94a3b8' : '#0f766e', color: '#fff', borderColor: 'transparent', opacity: disabled ? 0.65 : 1 }}>
          {workflow.isSendingCommand ? 'Connecting…' : '▶ Start Full Scan'}
        </button>
        {(['max30102', 'max30205'] as ScanSensor[]).map((sensor) => (
          <button key={sensor} type="button" onClick={() => onSelectSensor(sensor)} disabled={disabled}
            style={disabled ? mutedButton : buttonBase}>
            {sensorNames[sensor]}
          </button>
        ))}
        <button type="button" onClick={() => void workflow.stopScan()} disabled={!workflow.activeSensor || workflow.isSendingCommand}
          style={{ ...buttonBase, color: '#b91c1c', borderColor: '#fecaca', background: '#fff7f7' }}>■ Stop</button>
      </div>

      {!canCommand && (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: '#b45309' }}>
          Sensor switching is unavailable. Configure the server’s Supabase connection to send commands to the ESP32.
        </p>
      )}
      {detected && !stale && (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: '#475569' }}>Detected sensor: <b>{sensorNames[detected]}</b></p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '18px 0 14px', color: '#64748b', fontSize: 13, fontWeight: 700 }}>
        <span style={{ color: workflow.scanIndex === 0 ? '#0f766e' : workflow.captured.heart_rate !== null && workflow.captured.spo2 !== null ? '#059669' : '#94a3b8' }}>1 · MAX30102</span>
        <span style={{ flex: 1, height: 2, background: '#e2e8f0' }} />
        <span style={{ color: workflow.scanIndex === 1 ? '#0f766e' : workflow.captured.temperature !== null ? '#059669' : '#94a3b8' }}>2 · MAX30205</span>
      </div>

      <div style={{ minHeight: 96, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 18, border: '1px dashed #cbd5e1', borderRadius: 14, background: '#f8fafc' }}>
        <div>
          <div style={{ color: '#64748b', fontSize: 13 }}>{selectedName || 'Ready to scan'}</div>
          <div style={{ marginTop: 7, color: '#334155', fontWeight: 700, fontSize: 18 }}>{currentValue}</div>
          {workflow.activeSensor === 'max30102' && workflow.captured.heart_rate === null && <div style={{ marginTop: 5, fontSize: 12, color: '#64748b' }}>Place a finger steadily on MAX30102.</div>}
          {workflow.activeSensor === 'max30205' && workflow.captured.temperature === null && <div style={{ marginTop: 5, fontSize: 12, color: '#64748b' }}>Touch MAX30205 firmly and wait for a valid sample.</div>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 12, padding: '12px 8px', border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc', textAlign: 'center', color: '#64748b', fontSize: 13 }}>
        <span>HR: <b style={{ color: '#334155' }}>{workflow.captured.heart_rate ?? '--'}</b></span>
        <span>SpO₂: <b style={{ color: '#334155' }}>{workflow.captured.spo2 ?? '--'}</b></span>
        <span>Temp: <b style={{ color: '#334155' }}>{workflow.captured.temperature === null ? '--' : workflow.captured.temperature.toFixed(1) + ' °C'}</b></span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 12 }}>
        {workflow.isScanning && (
          <button type="button" onClick={() => void workflow.recordAndNextSensor()}
            disabled={workflow.isSaving || workflow.isSendingCommand}
            style={{ ...buttonBase, flex: '1 1 220px', background: '#0f766e', borderColor: 'transparent', color: '#fff', opacity: workflow.isSaving ? 0.65 : 1 }}>
            {workflow.isSaving ? 'Saving…' : workflow.scanIndex === 0 ? '✓ Record & Next Sensor' : '✓ Record & Finish Scan'}
          </button>
        )}
        <button type="button" onClick={() => void workflow.saveReading()}
          disabled={!workflow.canRecord || workflow.isSaving}
          style={{ ...(workflow.canRecord && !workflow.isSaving ? buttonBase : mutedButton), flex: '1 1 180px' }}>
          {workflow.isSaving ? 'Saving…' : '💾 Record Reading Only'}
        </button>
      </div>

      {workflow.notice && <p role="status" style={{ margin: '10px 0 0', fontSize: 13, color: '#047857' }}>{workflow.notice}</p>}
      {workflow.error && <p role="alert" style={{ margin: '10px 0 0', fontSize: 13, color: '#b91c1c' }}>{workflow.error}</p>}

      <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 18, paddingTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, color: '#0f172a', fontSize: 16 }}>Saved readings</h3>
          <button type="button" onClick={() => void workflow.loadReadings()} disabled={workflow.isLoadingReadings}
            style={buttonBase}>{workflow.isLoadingReadings ? 'Loading…' : '↻ Refresh'}</button>
        </div>
        {workflow.isLoadingReadings && workflow.readings.length === 0
          ? <p style={{ color: '#64748b', fontSize: 13 }}>Loading saved readings…</p>
          : workflow.readings.length === 0
            ? <p style={{ color: '#64748b', fontSize: 13 }}>No saved readings yet.</p>
            : <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {workflow.readings.map((reading) => (
                  <div key={reading.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '11px 12px', border: '1px solid #e2e8f0', borderRadius: 12 }}>
                    <div>
                      <b style={{ color: '#334155', fontSize: 13 }}>{formatDate(reading.recorded_at)}</b>
                      <div style={{ marginTop: 4, color: '#64748b', fontSize: 13 }}>
                        HR {reading.heart_rate} bpm · SpO₂ {reading.spo2}% · Temp {Number(reading.temperature).toFixed(1)} °C
                      </div>
                    </div>
                    {workflow.deleteId === reading.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: '#b91c1c', fontSize: 12 }}>Delete this reading?</span>
                        <button type="button" onClick={() => void workflow.confirmDelete()} disabled={workflow.isDeleting} style={{ ...buttonBase, color: '#b91c1c', padding: '7px 10px' }}>{workflow.isDeleting ? 'Deleting…' : 'Delete'}</button>
                        <button type="button" onClick={workflow.cancelDelete} disabled={workflow.isDeleting} style={{ ...buttonBase, padding: '7px 10px' }}>Cancel</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => workflow.requestDelete(reading.id)} style={{ ...buttonBase, color: '#b91c1c', borderColor: '#fecaca', padding: '7px 10px' }}>Delete</button>
                    )}
                  </div>
                ))}
              </div>}
      </div>
    </section>
  );
}
