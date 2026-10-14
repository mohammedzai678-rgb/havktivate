/**
 * Anticipation engine for the Voice Agent.
 *
 * Everything here runs in the browser (privacy by design - nothing is learned in the cloud):
 *  1. LEARNED PATTERN  - a personal baseline (mean / spread) per vital, persisted on this device.
 *  2. TIME-TO-EVENT    - linear trend over the last ~60 s -> "reaches attention level in ~N s".
 *  3. RISK SCORE       - 0..100 that climbs as precursors build, plus a +60 s projection.
 *  4. TRIGGERS         - decide *when the device should speak first*, before any hard threshold.
 *
 * These are assistive early-warning signals, not medical diagnoses.
 */

export type MetricKey = 'hr' | 'spo2' | 'temp';
export type TriggerTopic = 'nervous' | 'rising_hr' | 'high_temp' | 'rising_temp' | 'low_spo2';

export interface Sample { t: number; v: number }
export interface BaselineStat { n: number; mean: number; variance: number }
export type Baselines = Partial<Record<MetricKey, BaselineStat>>;
export type Sensitivity = Partial<Record<TriggerTopic, number>>;

const PRIOR: Record<MetricKey, { mean: number; sd: number; minSd: number }> = {
  hr: { mean: 74, sd: 10, minSd: 5 },
  spo2: { mean: 97, sd: 1.2, minSd: 0.8 },
  temp: { mean: 36.7, sd: 0.3, minSd: 0.15 },
};
const BASELINE_FULL_N = 40;
const MIN_BASELINE_N_FOR_RELATIVE_TRIGGERS = 10;
const MIN_RATE: Record<MetricKey, number> = { hr: 0.03, temp: 0.002, spo2: 0.005 }; // per second
const FRESH_MS = 10_000;

export const METRIC_LABEL: Record<MetricKey, string> = {
  hr: 'Heart rate', spo2: 'SpO\u2082', temp: 'Body temperature',
};
export const METRIC_UNIT: Record<MetricKey, string> = { hr: 'bpm', spo2: '%', temp: '\u00B0C' };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- baseline ---
export function effectiveBaseline(b: BaselineStat | undefined, key: MetricKey) {
  const p = PRIOR[key];
  const n = b?.n ?? 0;
  const w = n / (n + 20); // trust the learned value more as samples accumulate
  const mean = b ? w * b.mean + (1 - w) * p.mean : p.mean;
  const variance = b ? w * b.variance + (1 - w) * p.sd ** 2 : p.sd ** 2;
  return { mean, sd: Math.max(p.minSd, Math.sqrt(variance)), n, learned: Math.min(1, n / BASELINE_FULL_N) };
}

export function updateBaseline(b: BaselineStat | undefined, key: MetricKey, v: number): BaselineStat {
  const prev = b ?? { n: 0, mean: v, variance: PRIOR[key].sd ** 2 };
  const n = prev.n + 1;
  const alpha = Math.max(1 / n, 0.02); // running mean at first, slow EMA later (adapts as routine changes)
  const delta = v - prev.mean;
  return { n, mean: prev.mean + alpha * delta, variance: (1 - alpha) * (prev.variance + alpha * delta * delta) };
}

// ---------------------------------------------------------------- forecast ---
export interface Forecast { slope: number; current: number; r2: number; n: number; span: number }

export function linearForecast(samples: Sample[], now: number, windowMs = 60_000): Forecast | null {
  const pts = samples.filter((s) => now - s.t <= windowMs);
  if (pts.length < 6) return null;
  const span = (pts[pts.length - 1].t - pts[0].t) / 1000;
  if (span < 20) return null;
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / 1000);
  const ys = pts.map((p) => p.v);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);
  return { slope, current: intercept + slope * xs[n - 1], r2, n, span };
}

export function attentionLevel(key: MetricKey, mean: number, sd: number): number {
  if (key === 'hr') return Math.max(mean + 2.5 * sd, mean + 15);
  if (key === 'temp') return Math.max(Math.min(mean + 1.0, 37.8), mean + 0.5);
  return Math.min(mean - 3, 94);
}

function etaSeconds(key: MetricKey, fc: Forecast, target: number): number | null {
  const up = key !== 'spo2';
  const remaining = up ? target - fc.current : fc.current - target;
  const rate = up ? fc.slope : -fc.slope;
  if (remaining <= 0) return 0;
  if (rate < MIN_RATE[key]) return null;
  const eta = remaining / rate;
  return eta > 300 ? null : eta;
}

// ---------------------------------------------------------------- analysis ---
export interface MetricView {
  key: MetricKey;
  value: number | null;       // smoothed latest, only if fresh
  recent: number | null;      // last value seen in the past 2 min
  fresh: boolean;
  z: number | null;
  slopePerMin: number | null;
  etaSec: number | null;
  target: number;
  confidence: number;         // 0..1
  baseline: { mean: number; sd: number; n: number; learned: number };
  history: Sample[];
}

export interface Analysis {
  metrics: Record<MetricKey, MetricView>;
  risk: number;               // 0..100 now
  riskIn60: number;           // 0..100 projected
  learned: number;            // 0..1 overall baseline progress
}

const comp = (z: number) => clamp((z - 1) / 3, 0, 1);
const combine = (cs: number[]) => 1 - cs.reduce((a, c) => a * (1 - c), 1);

export function analyze(
  hist: Record<MetricKey, Sample[]>,
  baselines: Baselines,
  now: number,
): Analysis {
  const metrics = {} as Record<MetricKey, MetricView>;
  const compsNow: number[] = [];
  const compsFuture: number[] = [];
  let bonus = 0;

  (['hr', 'spo2', 'temp'] as MetricKey[]).forEach((key) => {
    const h = hist[key] ?? [];
    const base = effectiveBaseline(baselines[key], key);
    const last = h[h.length - 1];
    const fresh = !!last && now - last.t <= FRESH_MS;
    const lastFew = h.filter((s) => now - s.t <= FRESH_MS).slice(-3).map((s) => s.v).sort((a, b) => a - b);
    const value = fresh && lastFew.length ? lastFew[Math.floor(lastFew.length / 2)] : null;
    const recentSample = [...h].reverse().find((s) => now - s.t <= 120_000);
    const fc = fresh ? linearForecast(h, now) : null;
    const target = attentionLevel(key, base.mean, base.sd);
    const confidence = fc ? clamp(fc.r2 * Math.min(1, fc.n / 15) * (0.6 + 0.4 * base.learned), 0, 1) : 0;
    const eta = fc ? etaSeconds(key, fc, target) : null;
    const z = value === null ? null : (value - base.mean) / base.sd;
    const zSigned = z === null ? null : key === 'spo2' ? -z : z; // positive = worse

    if (zSigned !== null) {
      compsNow.push(comp(zSigned));
      let projected = value as number;
      if (fc && confidence >= 0.4) projected = value! + fc.slope * 60;
      const zf = ((projected - base.mean) / base.sd) * (key === 'spo2' ? -1 : 1);
      compsFuture.push(comp(zf));
    }
    if (eta !== null && eta < 180 && confidence >= 0.4) {
      bonus = Math.max(bonus, 0.25 * (1 - eta / 180) * confidence);
    }

    metrics[key] = {
      key, value, recent: recentSample?.v ?? null, fresh, z,
      slopePerMin: fc ? fc.slope * 60 : null,
      etaSec: eta, target, confidence, baseline: base, history: h.slice(-90),
    };
  });

  const risk = clamp(combine(compsNow) + bonus, 0, 1) * 100;
  const riskIn60 = clamp(combine(compsFuture) + bonus, 0, 1) * 100;
  const learned = (metrics.hr.baseline.learned + metrics.temp.baseline.learned) / 2;
  return { metrics, risk, riskIn60, learned };
}

// ---------------------------------------------------------------- triggers ---
export interface Trigger {
  topic: TriggerTopic;
  severity: 'info' | 'attention' | 'high';
  facts: string;     // sent to Gemini so it can word the opening line
  reason: string;    // shown on screen: why the device is speaking
  confidence: number;
  etaSec: number | null;
}

const fmtEta = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);

export function detectTrigger(
  a: Analysis,
  sens: Sensitivity,
  opts: { relaxLearning?: boolean } = {},
): Trigger | null {
  const { hr, spo2, temp } = a.metrics;
  const s = (t: TriggerTopic) => sens[t] ?? 1;
  const hrReady = opts.relaxLearning || hr.baseline.n >= MIN_BASELINE_N_FOR_RELATIVE_TRIGGERS;
  const tempReady = opts.relaxLearning || temp.baseline.n >= MIN_BASELINE_N_FOR_RELATIVE_TRIGGERS;

  // 1. Low oxygen - already low, or falling towards the attention level soon
  if (spo2.value !== null) {
    const falling = spo2.etaSec !== null && spo2.etaSec < 120 && spo2.confidence >= 0.5;
    if (spo2.value <= 93 || falling) {
      return {
        topic: 'low_spo2',
        severity: spo2.value <= 92 ? 'high' : 'attention',
        facts: `SpO2 ${spo2.value.toFixed(0)}% vs usual ${spo2.baseline.mean.toFixed(0)}%` +
          (falling ? `, falling, may reach ${spo2.target.toFixed(0)}% in about ${fmtEta(spo2.etaSec!)}` : ''),
        reason: `SpO\u2082 ${spo2.value.toFixed(0)}% (usual ${spo2.baseline.mean.toFixed(0)}%)` +
          (falling ? ` - forecast to hit ${spo2.target.toFixed(0)}% in ~${fmtEta(spo2.etaSec!)}` : ''),
        confidence: spo2.confidence || 0.8,
        etaSec: spo2.etaSec,
      };
    }
  }

  // 2. High temperature
  if (temp.value !== null && tempReady) {
    const hot = temp.value >= 37.8 || (temp.z ?? 0) >= 2.2 * s('high_temp');
    if (hot) {
      return {
        topic: 'high_temp',
        severity: temp.value >= 38.5 ? 'high' : 'attention',
        facts: `body temperature ${temp.value.toFixed(1)} C vs usual ${temp.baseline.mean.toFixed(1)} C`,
        reason: `Temperature ${temp.value.toFixed(1)}\u00B0C is ${(temp.value - temp.baseline.mean).toFixed(1)}\u00B0C above your usual`,
        confidence: 0.85,
        etaSec: null,
      };
    }
  }

  // 3. Nervous / restless: heart elevated, temperature not (so it is not a fever pattern)
  if (hr.value !== null && hrReady) {
    const tempZ = temp.recent !== null ? (temp.recent - temp.baseline.mean) / temp.baseline.sd : 0;
    const elevated = (hr.z ?? 0) >= 1.4 * s('nervous') && hr.value - hr.baseline.mean >= 8;
    if (elevated && tempZ < 1.5) {
      return {
        topic: 'nervous',
        severity: 'attention',
        facts: `heart rate ${hr.value.toFixed(0)} bpm vs usual ${hr.baseline.mean.toFixed(0)} bpm while body temperature is normal` +
          (hr.slopePerMin && hr.slopePerMin > 1 ? `, rising about ${hr.slopePerMin.toFixed(0)} bpm per minute` : ''),
        reason: `Heart rate ${hr.value.toFixed(0)} bpm is ${hr.z!.toFixed(1)}\u03C3 above your usual ${hr.baseline.mean.toFixed(0)} while temperature is normal`,
        confidence: clamp(0.5 + (hr.z! - 1.4) * 0.15, 0.5, 0.95),
        etaSec: hr.etaSec,
      };
    }
  }

  // 4. Temperature climbing (forecast, no threshold crossed yet)
  if (temp.etaSec !== null && temp.etaSec > 0 && temp.etaSec < 150 && temp.confidence >= 0.5 && tempReady) {
    return {
      topic: 'rising_temp',
      severity: 'info',
      facts: `body temperature ${temp.value?.toFixed(1)} C and rising about ${(temp.slopePerMin ?? 0).toFixed(2)} C per minute`,
      reason: `Forecast: temperature reaches ${temp.target.toFixed(1)}\u00B0C in ~${fmtEta(temp.etaSec)} (${Math.round(temp.confidence * 100)}% sure)`,
      confidence: temp.confidence,
      etaSec: temp.etaSec,
    };
  }

  // 5. Heart rate climbing (forecast)
  if (hr.etaSec !== null && hr.etaSec > 0 && hr.etaSec < 90 && hr.confidence >= 0.5 && hr.value !== null &&
      hr.value - hr.baseline.mean >= 5 && hrReady) {
    return {
      topic: 'rising_hr',
      severity: 'info',
      facts: `heart rate ${hr.value.toFixed(0)} bpm and climbing about ${(hr.slopePerMin ?? 0).toFixed(0)} bpm per minute`,
      reason: `Forecast: heart rate reaches ${hr.target.toFixed(0)} bpm in ~${fmtEta(hr.etaSec)} (${Math.round(hr.confidence * 100)}% sure)`,
      confidence: hr.confidence,
      etaSec: hr.etaSec,
    };
  }
  return null;
}

// ------------------------------------------------------------- persistence ---
const BASELINE_KEY = 'jeevan_voice_baseline_v1';
const SENS_KEY = 'jeevan_voice_sensitivity_v1';

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; }
}
export const loadBaselines = () => load<Baselines>(BASELINE_KEY, {});
export const saveBaselines = (b: Baselines) => { try { localStorage.setItem(BASELINE_KEY, JSON.stringify(b)); } catch { /* ignore */ } };
export const loadSensitivity = () => load<Sensitivity>(SENS_KEY, {});
export const saveSensitivity = (s: Sensitivity) => { try { localStorage.setItem(SENS_KEY, JSON.stringify(s)); } catch { /* ignore */ } };

/** Person said "I'm fine" -> ask a little less; said "unwell" -> ask a little sooner. */
export function adaptSensitivity(sens: Sensitivity, topic: TriggerTopic, feeling: 'fine' | 'unwell'): Sensitivity {
  const cur = sens[topic] ?? 1;
  const next = feeling === 'fine' ? Math.min(1.6, cur * 1.15) : Math.max(0.7, cur * 0.9);
  return { ...sens, [topic]: next };
}
