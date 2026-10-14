/**
 * Voice I/O for the Voice Agent: ElevenLabs speech (via the local Python service)
 * played on the chosen output (e.g. the Bluetooth headset) and one-shot listening.
 */
export const SERVER_URL =
  ((import.meta.env as unknown as Record<string, string | undefined>).VITE_SERVER_URL || '').trim() ||
  'http://localhost:8001';
const VOICE_URL = SERVER_URL;

export interface VoiceHealth { ok: boolean; gemini: boolean; elevenlabs: boolean; gemini_model?: string }
export interface ConverseResult { reply: string; intent: 'fine' | 'unwell' | 'help' | 'yes' | 'no' | 'unclear'; offer: 'none' | 'breathing' | 'alert' }
export interface Turn { role: 'agent' | 'user'; text: string }
export type Phrases = Record<string, string>;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${VOICE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

export async function voiceHealth(): Promise<VoiceHealth | null> {
  try {
    const res = await fetch(`${VOICE_URL}/health`);
    return res.ok ? ((await res.json()) as VoiceHealth) : null;
  } catch { return null; }
}

export const fetchQuestion = (p: { language: string; topic: string; facts: string; severity: string; person?: string }) =>
  post<{ text: string }>('/question', p);

export const fetchConverse = (p: {
  language: string; topic: string; facts: string; history: Turn[]; user_text: string; pending_offer: string;
}) => post<ConverseResult>('/converse', p);

export async function fetchPhrases(language: string): Promise<Phrases | null> {
  try {
    const res = await fetch(`${VOICE_URL}/phrases?language=${encodeURIComponent(language)}`);
    return res.ok ? ((await res.json()) as Phrases) : null;
  } catch { return null; }
}

// -------------------------------------------------------------------- speech ---
export type VoiceEngine = 'elevenlabs' | 'browser-fallback' | 'blocked';

export class Speaker {
  private audio = new Audio();
  private cache = new Map<string, string>();
  private resolveCurrent: (() => void) | null = null;
  sinkId = '';

  async speak(text: string, language: string, speechCode: string): Promise<VoiceEngine> {
    this.stop();
    const key = `${language}|${text}`;
    let url = this.cache.get(key);
    if (!url) {
      try {
        const res = await fetch(`${VOICE_URL}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, language }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        url = URL.createObjectURL(await res.blob());
        this.cache.set(key, url);
      } catch {
        return this.browserSpeak(text, speechCode);
      }
    }
    try {
      const setSink = (this.audio as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId;
      if (this.sinkId && setSink) await setSink.call(this.audio, this.sinkId).catch(() => undefined);
      this.audio.src = url;
      await new Promise<void>((resolve, reject) => {
        this.resolveCurrent = resolve;
        this.audio.onended = () => resolve();
        this.audio.onerror = () => reject(new Error('audio error'));
        this.audio.play().catch(reject);
      });
      return 'elevenlabs';
    } catch {
      return 'blocked';
    } finally {
      this.resolveCurrent = null;
    }
  }

  private browserSpeak(text: string, speechCode: string): Promise<VoiceEngine> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve('blocked');
      const u = new SpeechSynthesisUtterance(text);
      u.lang = speechCode;
      u.rate = 0.9;
      this.resolveCurrent = () => resolve('browser-fallback');
      u.onend = () => resolve('browser-fallback');
      u.onerror = () => resolve('blocked');
      window.speechSynthesis.speak(u);
    });
  }

  stop() {
    try { this.audio.pause(); } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    this.resolveCurrent?.();
    this.resolveCurrent = null;
  }
}

// ------------------------------------------------------------------ listening ---
export interface Listener { promise: Promise<string | null>; cancel: () => void }

/** Opens the microphone and resolves with transcript or null after 5 seconds of silence. */
export function listenOnce(speechCode: string, timeoutMs = 5000): Listener {
  const Ctor = (window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any })
    .SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;
  if (!Ctor) return { promise: Promise.resolve(null), cancel: () => undefined };

  const rec = new Ctor();
  rec.lang = speechCode;
  rec.interimResults = false;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let text = '';
  let done = false;
  let timer: number | undefined;
  const startTime = Date.now();

  const promise = new Promise<string | null>((resolve) => {
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(val);
    };

    rec.onresult = (e: any) => {
      text = Array.from(e.results as ArrayLike<any>).map((r) => r[0].transcript).join(' ').trim();
      finish(text || null);
    };
    rec.onerror = () => undefined;
    rec.onend = () => {
      if (text) {
        finish(text);
      } else {
        const elapsed = Date.now() - startTime;
        const remain = Math.max(0, timeoutMs - elapsed);
        window.setTimeout(() => finish(null), remain);
      }
    };
    try { rec.start(); } catch { finish(null); return; }
    timer = window.setTimeout(() => {
      try { rec.stop(); } catch { /* ignore */ }
      finish(text || null);
    }, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      done = true;
      window.clearTimeout(timer);
      try { rec.abort(); } catch { /* ignore */ }
    },
  };
}

// ---------------------------------------------------------- yes / no fallback ---
const YES = ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'please', 'haan', 'han', 'ha ', 'ji', 'à¤¹à¤¾à¤', 'à¤¹à¤¾à¤‚', 'à¤œà¥€', 'à¤ à¥€à¤•',
  'houdu', 'sari', 'à²¹à³Œà²¦à³', 'à²¸à²°à²¿', 'aam', 'à®†à®®à¯', 'à®šà®°à®¿', 'avunu', 'à°…à°µà±à°¨à±', 'à°¸à°°à±‡', 'à´…à´¤àµ†', 'à´¹à´¾', 'à¦¹à§à¦¯à¦¾à¦', 'à¤¹à¥‹'];
const NO = ['no', 'nope', 'not', "don't", 'nahi', 'nahin', 'à¤¨à¤¹à¥€à¤‚', 'à¤¨à¤¹à¥€', 'illa', 'à²‡à²²à³à²²', 'à®‡à®²à¯à®²à¯ˆ', 'à°²à±‡à°¦à±', 'à´‡à´²àµà´²', 'à¦¨à¦¾'];

export function localYesNo(text: string): 'yes' | 'no' | 'unclear' {
  const t = ` ${text.toLowerCase()} `;
  if (NO.some((w) => t.includes(w))) return 'no';
  if (YES.some((w) => t.includes(w))) return 'yes';
  return 'unclear';
}

export function localIntent(text: string): 'fine' | 'unwell' | 'help' | 'unclear' {
  const t = text.toLowerCase();
  if (/(help|chest|can'?t breathe|cannot breathe|faint|fell|fall|pain|bachao|madad|à®‰à®¤à®µà®¿|à²¸à²¹à²¾à²¯|à°¸à°¹à°¾à°¯à°‚)/i.test(t)) return 'help';
  if (/(not (fine|ok|well|good)|nervous|anxious|dizzy|hot|fever|tired|weak|scared|worried|uneasy|ghabra|bechain|à²—à²¾à²¬à²°à²¿|à®ªà®¯à®®à¯|à°­à°¯à°‚)/i.test(t)) return 'unwell';
  if (/(fine|ok|okay|good|alright|well|theek|thik|accha|sari|à²šà³†à²¨à³à²¨à²¾à²—à²¿|à®¨à®©à¯à®±à®¾à®•|à°¬à°¾à°—à±à°¨à±à°¨à°¾à°¨à±)/i.test(t)) return 'fine';
  return 'unclear';
}
