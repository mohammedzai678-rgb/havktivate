import { useCallback, useEffect, useState } from 'react';
import type { Analysis } from '../lib/anticipation';
import { SERVER_URL } from '../lib/voiceClient';
import type { DeviceStatus } from './useDeviceFeed';

export type ScanSensor = 'max30102' | 'max30205';

export interface ScanReading {
  id: string;
  heart_rate: number;
  spo2: number;
  temperature: number;
  recorded_at: string;
  source: string;
  notes?: string | null;
}

interface CapturedVitals {
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
}

interface UseSensorWorkflowOptions {
  metrics: Analysis['metrics'] | null;
  status: DeviceStatus | null;
  sendCommand: (command: string) => Promise<boolean>;
  beforeSensorCommand?: () => Promise<void>;
}

const emptyVitals = (): CapturedVitals => ({ heart_rate: null, spo2: null, temperature: null });
const commandFor: Record<ScanSensor, string> = {
  max30102: 'read_max30102',
  max30205: 'read_dht11',
};
const freshTelemetry = (status: DeviceStatus | null) =>
  !!status?.online && status.age_ms >= 0 && status.age_ms < 10_000;

export function useSensorWorkflow({ metrics, status, sendCommand, beforeSensorCommand }: UseSensorWorkflowOptions) {
  const [activeSensor, setActiveSensor] = useState<ScanSensor | null>(null);
  const [sensorStartedAt, setSensorStartedAt] = useState(0);
  const [scanIndex, setScanIndex] = useState(-1);
  const [isScanning, setIsScanning] = useState(false);
  const [isSendingCommand, setIsSendingCommand] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingReadings, setIsLoadingReadings] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [readings, setReadings] = useState<ScanReading[]>([]);
  const [captured, setCaptured] = useState<CapturedVitals>(emptyVitals);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!metrics || !freshTelemetry(status) || !status?.updated_at || status.updated_at < sensorStartedAt) return;
    const data = status?.data ?? {};
    const sensor = String(status?.sensor ?? '').toLowerCase();
    const model = String(data.sensor_model ?? '').toUpperCase();
    const pulseActive = activeSensor === 'max30102' &&
      (sensor.includes('max30102') || data.finger_detected === true) &&
      data.finger_detected === true;
    const temperatureActive = activeSensor === 'max30205' &&
      (model === 'MAX30205' || sensor.includes('max30205')) &&
      model === 'MAX30205' && data.valid === true;

    if (!pulseActive && !temperatureActive) return;
    setCaptured((previous) => {
      const next = { ...previous };
      if (pulseActive && data.heart_rate_valid === true && metrics.hr.fresh && metrics.hr.value !== null) {
        next.heart_rate = Math.round(metrics.hr.value);
      }
      if (pulseActive && data.spo2_valid === true && metrics.spo2.fresh && metrics.spo2.value !== null) {
        next.spo2 = Math.round(metrics.spo2.value);
      }
      if (temperatureActive && metrics.temp.fresh && metrics.temp.value !== null) {
        next.temperature = Number(metrics.temp.value.toFixed(1));
      }
      return next.heart_rate === previous.heart_rate && next.spo2 === previous.spo2 && next.temperature === previous.temperature
        ? previous
        : next;
    });
  }, [activeSensor, metrics, sensorStartedAt, status]);

  const loadReadings = useCallback(async () => {
    setIsLoadingReadings(true);
    setError('');
    try {
      const response = await fetch(SERVER_URL + '/api/device/readings?limit=50', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load saved readings.');
      const body = await response.json();
      setReadings(Array.isArray(body.readings) ? body.readings : []);
    } catch {
      setError('Could not load saved readings. Check that the server is running.');
    } finally {
      setIsLoadingReadings(false);
    }
  }, []);

  useEffect(() => { void loadReadings(); }, [loadReadings]);

  const issueCommand = useCallback(async (command: string) => {
    setIsSendingCommand(true);
    setError('');
    try {
      const sent = await sendCommand(command);
      if (!sent) throw new Error('The sensor command could not be sent.');
      return true;
    } catch {
      setError('The sensor command could not be sent. Check that the server is running.');
      return false;
    } finally {
      setIsSendingCommand(false);
    }
  }, [sendCommand]);

  const startFullScan = useCallback(async () => {
    await beforeSensorCommand?.();
    setSensorStartedAt(Date.now());
    setCaptured(emptyVitals());
    setNotice('');
    setScanIndex(0);
    setActiveSensor('max30102');
    setIsScanning(true);
    if (!await issueCommand(commandFor.max30102)) {
      setScanIndex(-1);
      setActiveSensor(null);
      setIsScanning(false);
    }
  }, [beforeSensorCommand, issueCommand]);

  const startSensor = useCallback(async (sensor: ScanSensor) => {
    await beforeSensorCommand?.();
    setSensorStartedAt(Date.now());
    setNotice('');
    setCaptured((previous) => sensor === 'max30102'
      ? { ...previous, heart_rate: null, spo2: null }
      : { ...previous, temperature: null });
    if (!await issueCommand(commandFor[sensor])) {
      setActiveSensor(null);
      setScanIndex(-1);
      return;
    }
    setActiveSensor(sensor);
    setScanIndex(sensor === 'max30102' ? 0 : 1);
    setIsScanning(false);
  }, [beforeSensorCommand, issueCommand]);

  const stopScan = useCallback(async () => {
    setActiveSensor(null);
    setScanIndex(-1);
    setIsScanning(false);
    await issueCommand('idle');
  }, [issueCommand]);

  const saveReading = useCallback(async () => {
    if (captured.heart_rate === null || captured.spo2 === null || captured.temperature === null) {
      setNotice('Get a valid pulse/SpO₂ reading and temperature reading before saving.');
      return false;
    }
    setIsSaving(true);
    setError('');
    try {
      const response = await fetch(SERVER_URL + '/api/device/readings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          heart_rate: captured.heart_rate,
          spo2: captured.spo2,
          temperature: captured.temperature,
          source: 'esp32',
        }),
      });
      if (!response.ok) throw new Error('Could not save this reading.');
      const body = await response.json();
      const reading = body.reading as ScanReading | undefined;
      if (!reading) throw new Error('The server did not return the saved reading.');
      setReadings((previous) => [reading, ...previous.filter((item) => item.id !== reading.id)].slice(0, 50));
      setNotice('Reading saved.');
      return true;
    } catch {
      setError('Could not save this reading. Check the server connection and try again.');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [captured]);

  const recordAndNextSensor = useCallback(async () => {
    if (!isScanning || !activeSensor) return;
    if (activeSensor === 'max30102' && (captured.heart_rate === null || captured.spo2 === null)) {
      setNotice('Waiting for valid MAX30102 pulse and SpO₂ data. Place a finger steadily on the sensor.');
      return;
    }
    if (activeSensor === 'max30205' && captured.temperature === null) {
      setNotice('Waiting for a valid MAX30205 temperature reading. Touch the sensor firmly.');
      return;
    }

    if (scanIndex === 0) {
      setSensorStartedAt(Date.now());
      setScanIndex(1);
      setActiveSensor('max30205');
      setNotice('');
      await issueCommand(commandFor.max30205);
      return;
    }

    if (await saveReading()) {
      await issueCommand('idle');
      setIsScanning(false);
      setActiveSensor(null);
      setScanIndex(-1);
    }
  }, [activeSensor, captured, isScanning, issueCommand, saveReading, scanIndex]);

  const requestDelete = useCallback((id: string) => setDeleteId(id), []);
  const cancelDelete = useCallback(() => setDeleteId(null), []);
  const confirmDelete = useCallback(async () => {
    if (!deleteId) return;
    setIsDeleting(true);
    setError('');
    try {
      const response = await fetch(SERVER_URL + '/api/device/readings/' + encodeURIComponent(deleteId), { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete this reading.');
      setReadings((previous) => previous.filter((item) => item.id !== deleteId));
      setDeleteId(null);
      setNotice('Reading deleted.');
    } catch {
      setError('Could not delete this reading. Try again.');
    } finally {
      setIsDeleting(false);
    }
  }, [deleteId]);

  return {
    activeSensor,
    scanIndex,
    isScanning,
    isSendingCommand,
    isSaving,
    isLoadingReadings,
    isDeleting,
    deleteId,
    readings,
    captured,
    notice,
    error,
    canRecord: captured.heart_rate !== null && captured.spo2 !== null && captured.temperature !== null,
    startFullScan,
    startSensor,
    stopScan,
    saveReading,
    recordAndNextSensor,
    loadReadings,
    requestDelete,
    cancelDelete,
    confirmDelete,
  };
}


