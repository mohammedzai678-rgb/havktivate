"""
Jeevan Voice Agent service
--------------------------
Local service behind the Jeevan Voice Agent page (standalone project).

  GET  /health    -> which API keys are configured
  GET  /api/device/status   -> live ESP32 readings received directly by this local service, with cloud fallback
  POST /api/device/command  -> choose which ESP32 sensor streams (idle / read_max30102 / read_dht11)
  POST /tts       -> ElevenLabs text-to-speech (returns audio/mpeg)
  POST /question  -> Gemini writes the *opening line* the device speaks first
  POST /converse  -> Gemini interprets the person's spoken reply
  GET  /phrases   -> fixed UI/voice phrases translated to the chosen language

API keys stay on this machine (never in the browser):
  ELEVENLABS_API_KEY   (server/.env)
  GEMINI_API_KEY       (server/.env)

Run:  uvicorn main:app --host 0.0.0.0 --port 8001 --reload
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import json
import os
import re
import time
from uuid import uuid4
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

GEMINI_API_VERSION = os.getenv("GEMINI_API_VERSION", "v1beta")
GEMINI_MODEL = os.getenv("VOICE_GEMINI_MODEL") or os.getenv("GEMINI_MODEL") or "gemini-3.8-flash"

ELEVEN_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # "Rachel" (premade)
ELEVEN_MODEL_DEFAULT = os.getenv("ELEVENLABS_MODEL_DEFAULT", "eleven_multilingual_v2")
ELEVEN_MODEL_INDIC = os.getenv("ELEVENLABS_MODEL_INDIC", "eleven_v3")
# Languages covered by eleven_multilingual_v2; everything else (Kannada, Telugu, ...) uses v3.
MULTILINGUAL_V2_LANGS = {"en", "hi", "ta"}

LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "kn": "Kannada", "ta": "Tamil", "te": "Telugu",
    "ml": "Malayalam", "bn": "Bengali", "mr": "Marathi", "gu": "Gujarati", "pa": "Punjabi",
    "ur": "Urdu", "or": "Odia",
}

app = FastAPI(title="Jeevan Voice Agent")
origins = [
    o.strip()
    for o in os.getenv("VOICE_AGENT_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

_tts_cache: dict[str, bytes] = {}
_phrase_cache: dict[str, dict[str, str]] = {}


def lang_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code, "English")


# ----------------------------------------------------------------------------
# Gemini helper
# ----------------------------------------------------------------------------
async def gemini_json(system: str, user: str, max_tokens: int = 2048) -> dict:
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(503, "GEMINI_API_KEY is not configured")
    url = f"https://generativelanguage.googleapis.com/{GEMINI_API_VERSION}/models/{GEMINI_MODEL}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": 0.5,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
        },
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(url, json=body, headers={"x-goog-api-key": key})
    if r.status_code != 200:
        raise HTTPException(502, f"Gemini error {r.status_code}: {r.text[:300]}")
    try:
        parts = r.json()["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in parts if "text" in p).strip()
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
        return json.loads(text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Gemini returned unreadable output: {exc}") from exc


# ----------------------------------------------------------------------------
# Health
# ----------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {
        "ok": True,
        "gemini": bool(os.getenv("GEMINI_API_KEY")),
        "elevenlabs": bool(os.getenv("ELEVENLABS_API_KEY")),
        "gemini_model": GEMINI_MODEL,
        "voice_id": ELEVEN_VOICE_ID,
    }


# ----------------------------------------------------------------------------
# ElevenLabs TTS
# ----------------------------------------------------------------------------
class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=700)
    language: str = "en"


@app.post("/tts")
async def tts(req: TTSRequest):
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        raise HTTPException(503, "ELEVENLABS_API_KEY is not configured")

    model = ELEVEN_MODEL_DEFAULT if req.language in MULTILINGUAL_V2_LANGS else ELEVEN_MODEL_INDIC
    cache_key = hashlib.sha256(f"{ELEVEN_VOICE_ID}|{model}|{req.text}".encode()).hexdigest()
    if cache_key in _tts_cache:  # save credits on repeated phrases
        return Response(_tts_cache[cache_key], media_type="audio/mpeg")

    if model == "eleven_v3":
        settings = {"stability": 0.5}  # v3 only accepts discrete stability values
    else:
        settings = {
            "stability": 0.55,
            "similarity_boost": 0.75,
            "style": 0.1,
            "use_speaker_boost": True,
            "speed": 0.92,  # slightly slower: easier to follow
        }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE_ID}",
            params={"output_format": "mp3_44100_64"},
            headers={"xi-api-key": key},
            json={"text": req.text, "model_id": model, "voice_settings": settings},
        )
    if r.status_code != 200:
        raise HTTPException(502, f"ElevenLabs error {r.status_code}: {r.text[:300]}")
    if len(_tts_cache) > 300:
        _tts_cache.pop(next(iter(_tts_cache)))
    _tts_cache[cache_key] = r.content
    return Response(r.content, media_type="audio/mpeg")


# ----------------------------------------------------------------------------
# Gemini: proactive opening line
# ----------------------------------------------------------------------------
class QuestionRequest(BaseModel):
    language: str = "en"
    topic: str
    facts: str
    severity: str = "info"
    person: str | None = None


QUESTION_SYSTEM = """You are "Jeevan Voice", a calm, caring companion inside a wrist health-monitoring device.
The device's sensors noticed something, so YOU speak first. Write ONE short opening line.
Rules:
- Write ONLY in {lang}, in its native script (no transliteration, no English words unless unavoidable).
- Maximum 25 words. Warm, polite, unhurried. Never alarming.
- Say briefly what you noticed, then ask ONE gentle question about how the person feels.
- Never diagnose, never name a disease, never advise medicines.
- No emojis, no markdown, no numbers unless essential.
Return JSON exactly: {{"text": "<the line>"}}"""


@app.post("/question")
async def question(req: QuestionRequest):
    user = (
        f"Person: {req.person or 'the wearer'}\nTopic: {req.topic}\nSeverity: {req.severity}\n"
        f"What the sensors and forecast show: {req.facts}"
    )
    data = await gemini_json(QUESTION_SYSTEM.format(lang=lang_name(req.language)), user, 2048)
    text = str(data.get("text", "")).strip()
    if not text:
        raise HTTPException(502, "Gemini returned an empty line")
    return {"text": text}


# ----------------------------------------------------------------------------
# Gemini: understand the person's reply
# ----------------------------------------------------------------------------
class Turn(BaseModel):
    role: Literal["agent", "user"]
    text: str


class ConverseRequest(BaseModel):
    language: str = "en"
    topic: str
    facts: str
    history: list[Turn] = []
    user_text: str
    pending_offer: Literal["none", "breathing", "alert"] = "none"


CONVERSE_SYSTEM = """You are "Jeevan Voice", a calm companion in a wrist health-monitoring device, talking with the wearer.
You asked them how they feel because the sensors noticed: {facts}
Reply ONLY in {lang} (native script). Max 30 words. Warm and simple. You are an assistive aid, not a doctor:
never diagnose, never name diseases, never recommend medicines.

Classify the person's latest reply into "intent":
 - "fine"    : they say they are okay / nothing wrong
 - "unwell"  : they feel unwell, nervous, anxious, hot, dizzy, tired, uncomfortable
 - "help"    : urgent trouble (chest pain, cannot breathe, faint, fall, "help")
 - "yes" / "no" : ONLY when the previous agent turn asked for confirmation (pending_offer = {pending}) and they agree/refuse
 - "unclear" : you could not understand

Then write "reply" and choose "offer":
 - fine    -> acknowledge kindly, offer "none".
 - unwell  -> one safe simple tip (sit down, sip water, slow breaths). If nervousness / fast heartbeat is likely, ask
              whether they want you to guide their breathing and set offer "breathing".
 - help    -> tell them to sit down and stay calm, ask whether you should message their caregiver, offer "alert".
              NEVER say you have already alerted anyone.
 - yes + pending breathing -> say you will begin now, offer "none".
 - yes + pending alert     -> say you are preparing the message for them to send, offer "none".
 - no  -> say that is fine and you will stay nearby, offer "none".
 - unclear -> gently ask them to repeat, offer "none".
Return JSON exactly: {{"reply": "...", "intent": "...", "offer": "none|breathing|alert"}}"""


@app.post("/converse")
async def converse(req: ConverseRequest):
    transcript = "\n".join(f"{t.role}: {t.text}" for t in req.history[-8:])
    user = f"Conversation so far:\n{transcript}\n\nLatest reply from the person: {req.user_text}"
    system = CONVERSE_SYSTEM.format(
        facts=req.facts, lang=lang_name(req.language), pending=req.pending_offer
    )
    data = await gemini_json(system, user, 2048)
    intent = str(data.get("intent", "unclear")).lower()
    if intent not in {"fine", "unwell", "help", "yes", "no", "unclear"}:
        intent = "unclear"
    offer = str(data.get("offer", "none")).lower()
    if offer not in {"none", "breathing", "alert"}:
        offer = "none"
    return {"reply": str(data.get("reply", "")).strip(), "intent": intent, "offer": offer}


# ----------------------------------------------------------------------------
# Phrase pack (fixed lines, translated once per language)
# ----------------------------------------------------------------------------
ENGLISH_PHRASES = {
    "greeting": "Hi, I am there to help you.",
    "reprompt": "I am here. Are you feeling alright?",
    "check_again": "Okay. I will check on you again in a little while.",
    "stay_nearby": "That is fine. I will stay nearby.",
    "breathe_in": "Breathe in slowly.",
    "hold": "Hold gently.",
    "breathe_out": "Now breathe out slowly.",
    "breathing_done": "Well done. Let us see how your readings settle.",
    "alert_prepared": "I have prepared a message for {name}. Please tap send on the screen.",
    "no_caregiver": "I could not find a caregiver number. Please add one on the screen.",
    "q_nervous": "Your heartbeat seems a little fast. Are you feeling nervous or restless?",
    "q_rising_hr": "Your heartbeat has been climbing for a while. Are you alright?",
    "q_high_temp": "Your temperature seems high. Are you feeling hot or feverish?",
    "q_rising_temp": "Your temperature is slowly rising. Do you feel warm or unwell?",
    "q_low_spo2": "Your oxygen reading looks lower than usual. Please sit upright. Are you finding it hard to breathe?",
    "q_manual": "I am listening. How are you feeling?",
    "test_voice": "Hello. This is how I will sound through your headset.",
    "ack_fine": "I am glad you are alright.",
    "offer_breathing": "Would you like me to guide your breathing?",
    "offer_alert": "Shall I prepare a message to your caregiver?",
    "unclear": "Sorry, I did not catch that. Could you say it again?",
}


@app.get("/phrases")
async def phrases(language: str = Query("en")):
    if language == "en":
        return ENGLISH_PHRASES
    if language in _phrase_cache:
        return _phrase_cache[language]
    system = (
        f"Translate the values of this JSON object into {lang_name(language)}, native script, "
        "warm and polite spoken tone, suitable for an elderly listener. Keep the keys unchanged. "
        "Keep placeholders such as {name} exactly as they are. Return only the JSON object."
    )
    try:
        data = await gemini_json(system, json.dumps(ENGLISH_PHRASES, ensure_ascii=False), 2500)
        out = {k: str(data.get(k) or v) for k, v in ENGLISH_PHRASES.items()}
    except HTTPException:
        return ENGLISH_PHRASES  # graceful fallback; do not cache failures
    _phrase_cache[language] = out
    return out


# ----------------------------------------------------------------------------
# ESP32 / VitaWatch hardware link
# The firmware is used exactly as flashed (same Wi-Fi, same pins, same endpoint).
# It already posts its readings to the cloud endpoint below, so we read them from there.
# ----------------------------------------------------------------------------
DEVICE_ID = os.getenv("DEVICE_ID", "esp32_jeevancare_01")
DEVICE_BACKEND_URL = os.getenv("DEVICE_BACKEND_URL", "").rstrip("/")
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
VALID_COMMANDS = {"idle", "read_max30102", "read_dht11", "read_ad8232"}
LOG_PATH = HERE / "data" / "vitals_log.csv"
READINGS_PATH = HERE / "data" / "scan_readings.json"
REMINDERS_PATH = HERE / "data" / "medicine_reminders.json"

_http = httpx.AsyncClient(timeout=8)
_status_cache: dict = {"t": 0.0, "val": None}
_last_logged = {"ts": 0}
_current_command = {"cmd": "idle"}
_bg_tasks: set[asyncio.Task] = set()
_reminder_state: dict = {"active": False, "slot": "", "updated_at": 0}
_stream_cache: dict = {
    "sensor": "idle",
    "data": {},
    "signal_quality": "UNKNOWN",
    "updated_at": 0,
}


def _can_command() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _log_sample(sensor: str, d: dict, ts_ms: int) -> None:
    """Keep a CSV of every real reading the hardware produced (prediction is only as good as its data)."""
    row = None
    if d.get("finger_detected") and d.get("heart_rate_valid"):
        row = [sensor, d.get("heart_rate"), d.get("spo2"), ""]
    elif d.get("valid") and d.get("sensor_model") == "MAX30205":
        row = [sensor, "", "", d.get("temperature")]
    if not row or ts_ms == _last_logged["ts"]:
        return
    _last_logged["ts"] = ts_ms
    LOG_PATH.parent.mkdir(exist_ok=True)
    new = not LOG_PATH.exists()
    with LOG_PATH.open("a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["time_utc", "sensor", "heart_rate", "spo2", "body_temp_c"])
        w.writerow([datetime.fromtimestamp(ts_ms / 1000, timezone.utc).isoformat(), *row])


class LiveStreamBody(BaseModel):
    device_id: str = "esp32_jeevancare_01"
    sensor: str = "idle"
    data: dict = Field(default_factory=dict)
    signal_quality: str | None = None
    timestamp: int | None = None
    api_key: str | None = None


@app.post("/api/device/live-stream")
async def device_live_stream_ingest(body: LiveStreamBody):
    """Accept ESP32 telemetry locally first; cloud synchronization is best-effort."""
    now_ms = int(time.time() * 1000)
    _stream_cache.update({
        "sensor": body.sensor,
        "data": body.data,
        "signal_quality": body.signal_quality or "GOOD",
        "updated_at": now_ms,
    })
    _status_cache.update({"t": 0.0, "val": None})
    try:
        _log_sample(body.sensor, body.data, now_ms)
    except OSError:
        pass  # e.g. CSV open in Excel; never fail the device request because of logging

    # Cloud sync is fire-and-forget so the ESP32 always gets an instant reply.
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        payload = {
            "device_id": body.device_id,
            "sensor": body.sensor,
            "data": body.data,
            "signal_quality": body.signal_quality or "GOOD",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        async def _sync() -> None:
            try:
                await _http.post(
                    f"{SUPABASE_URL}/rest/v1/device_live_stream",
                    params={"on_conflict": "device_id"},
                    headers={
                        "apikey": SUPABASE_SERVICE_ROLE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                        "Content-Type": "application/json",
                        "Prefer": "resolution=merge-duplicates",
                    },
                    json=payload,
                    timeout=1.5,
                )
            except Exception:  # noqa: BLE001
                pass

        task = asyncio.create_task(_sync())
        _bg_tasks.add(task)
        task.add_done_callback(_bg_tasks.discard)
    return {
        "status": "ok",
        "received_at": now_ms,
        "command": _current_command["cmd"],
        "reminder_led": _reminder_state["active"],
        "reminder_slot": _reminder_state["slot"],
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/device/reminders/active")
async def get_active_reminder():
    return _reminder_state


class ActiveReminderBody(BaseModel):
    active: bool
    slot: str = ""


@app.post("/api/device/reminders/active")
async def set_active_reminder(body: ActiveReminderBody):
    _reminder_state.update({
        "active": body.active,
        "slot": body.slot,
        "updated_at": int(time.time() * 1000),
    })
    return {"status": "ok", "reminder_state": _reminder_state}


@app.post("/api/device/reminders/acknowledge")
async def acknowledge_reminder():
    _reminder_state.update({
        "active": False,
        "slot": "",
        "updated_at": int(time.time() * 1000),
    })
    return {"status": "ok", "acknowledged": True}


@app.post("/api/device/ingest")
async def device_ingest(body: LiveStreamBody):
    """Fallback ingest endpoint for legacy firmware."""
    return await device_live_stream_ingest(body)


@app.get("/api/device/status")
async def device_status():
    now = time.time()
    if _status_cache["val"] is not None and now - _status_cache["t"] < 0.8:
        return _status_cache["val"]
    out = {
        "online": False,
        "reachable": True,
        "sensor": "idle",
        "data": {},
        "age_ms": 0,
        "updated_at": 0,
        "can_command": True,  # local command queue works even when cloud sync is offline
        "device_id": DEVICE_ID,
    }

    # 1. Direct in-memory stream from local ESP32 Wi-Fi
    if _stream_cache["updated_at"] > 0:
        age_ms = int(now * 1000 - _stream_cache["updated_at"])
        if age_ms < 15000:
            out.update({
                "online": True,
                "reachable": True,
                "sensor": _stream_cache["sensor"],
                "data": _stream_cache["data"],
                "age_ms": age_ms,
                "updated_at": _stream_cache["updated_at"],
            })
            _status_cache.update({"t": now, "val": out})
            return out

    # 2. Supabase device_live_stream query
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        try:
            r = await _http.get(
                f"{SUPABASE_URL}/rest/v1/device_live_stream",
                params={"device_id": f"eq.{DEVICE_ID}", "select": "*"},
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                },
                timeout=1.5,
            )
            if r.status_code == 200:
                rows = r.json()
                if rows:
                    raw = rows[0]
                    updated_ms = 0
                    if raw.get("updated_at"):
                        updated_ms = int(
                            datetime.fromisoformat(str(raw["updated_at"]).replace("Z", "+00:00")).timestamp() * 1000
                        )
                    age_ms = max(0, int(now * 1000 - updated_ms))
                    is_online = age_ms < 15000
                    out.update({
                        "reachable": True,
                        "online": is_online,
                        "sensor": raw.get("sensor") or "idle",
                        "data": raw.get("data") or {},
                        "age_ms": age_ms,
                        "updated_at": updated_ms,
                    })
                    if is_online:
                        _log_sample(out["sensor"], out["data"], updated_ms)
                    _status_cache.update({"t": now, "val": out})
                    return out
        except Exception:
            pass

    # 3. Optional fallback to legacy URL if explicitly configured
    if DEVICE_BACKEND_URL:
        try:
            r = await _http.get(f"{DEVICE_BACKEND_URL}/api/device/status", params={"device_id": DEVICE_ID}, timeout=1.5)
            raw = r.json()
            updated_ms = 0
            if raw.get("updated_at"):
                updated_ms = int(datetime.fromisoformat(str(raw["updated_at"]).replace("Z", "+00:00")).timestamp() * 1000)
            out.update({
                "reachable": True,
                "online": bool(raw.get("online")),
                "sensor": raw.get("sensor") or "idle",
                "data": raw.get("data") or {},
                "age_ms": int(raw.get("age_ms") if raw.get("age_ms") is not None else max(0, now * 1000 - updated_ms)),
                "updated_at": updated_ms,
            })
            if out["online"]:
                _log_sample(out["sensor"], out["data"], updated_ms)
        except Exception:
            out["reachable"] = False

    _status_cache.update({"t": now, "val": out})
    return out


DEFAULT_MEDICINE_REMINDERS = {"morning": "08:00", "afternoon": "14:00", "evening": "20:00"}


class MedicineReminderBody(BaseModel):
    morning: str
    afternoon: str
    evening: str


def _valid_reminder_time(value: str) -> bool:
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        return False
    return True


def _load_medicine_reminders() -> dict:
    if not REMINDERS_PATH.exists():
        return {"reminders": dict(DEFAULT_MEDICINE_REMINDERS), "updated_at": None}
    try:
        stored = json.loads(REMINDERS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"reminders": dict(DEFAULT_MEDICINE_REMINDERS), "updated_at": None}
    reminders = stored.get("reminders", {}) if isinstance(stored, dict) else {}
    merged = {
        key: reminders.get(key, default)
        for key, default in DEFAULT_MEDICINE_REMINDERS.items()
    }
    if not all(_valid_reminder_time(value) for value in merged.values()):
        merged = dict(DEFAULT_MEDICINE_REMINDERS)
    return {"reminders": merged, "updated_at": stored.get("updated_at") if isinstance(stored, dict) else None}


def _save_medicine_reminders(reminders: dict) -> dict:
    record = {"reminders": reminders, "updated_at": datetime.now(timezone.utc).isoformat()}
    REMINDERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = REMINDERS_PATH.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_path.replace(REMINDERS_PATH)
    return record


@app.get("/api/device/reminders")
async def get_medicine_reminders():
    return _load_medicine_reminders()


@app.put("/api/device/reminders")
async def update_medicine_reminders(body: MedicineReminderBody):
    reminders = {
        "morning": body.morning,
        "afternoon": body.afternoon,
        "evening": body.evening,
    }
    invalid = [slot for slot, value in reminders.items() if not _valid_reminder_time(value)]
    if invalid:
        raise HTTPException(422, "Reminder times must use 24-hour HH:MM format")
    return _save_medicine_reminders(reminders)

class ScanReadingBody(BaseModel):
    heart_rate: int = Field(ge=20, le=300)
    spo2: int = Field(ge=40, le=100)
    temperature: float = Field(ge=25, le=45)
    source: Literal["esp32", "manual"] = "esp32"
    notes: str | None = Field(default=None, max_length=500)


def _local_scan_readings() -> list[dict]:
    if not READINGS_PATH.exists():
        return []
    try:
        rows = json.loads(READINGS_PATH.read_text(encoding="utf-8"))
        return rows if isinstance(rows, list) else []
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, "Saved reading history could not be read") from exc


def _save_local_scan_readings(rows: list[dict]) -> None:
    READINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = READINGS_PATH.with_suffix(".tmp")
    temporary_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_path.replace(READINGS_PATH)


def _supabase_reading_headers(prefer: str | None = None) -> dict[str, str]:
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


@app.get("/api/device/readings")
async def list_device_readings(limit: int = Query(50, ge=1, le=100)):
    if _can_command():
        try:
            response = await _http.get(
                f"{SUPABASE_URL}/rest/v1/vitawatch_readings",
                params={
                    "device_id": f"eq.{DEVICE_ID}",
                    "select": "id,heart_rate,spo2,temperature,source,notes,recorded_at",
                    "order": "recorded_at.desc",
                    "limit": limit,
                },
                headers=_supabase_reading_headers(),
                timeout=1.5,
            )
            if response.status_code < 300:
                cloud_rows = response.json()
                local_rows = _local_scan_readings()
                combined = {str(row.get("id")): row for row in [*cloud_rows, *local_rows]}
                rows = sorted(combined.values(), key=lambda row: row.get("recorded_at", ""), reverse=True)
                return {"readings": rows[:limit]}
        except (httpx.HTTPError, ValueError):
            pass

    return {"readings": _local_scan_readings()[:limit]}


@app.post("/api/device/readings", status_code=201)
async def save_device_reading(body: ScanReadingBody):
    recorded_at = datetime.now(timezone.utc).isoformat()
    reading = {
        "heart_rate": body.heart_rate,
        "spo2": body.spo2,
        "temperature": round(body.temperature, 2),
        "source": body.source,
        "notes": body.notes,
        "recorded_at": recorded_at,
    }

    if _can_command():
        payload = {
            **reading,
            "device_id": DEVICE_ID,
            "ecg_bpm": None,
            "ecg_status": "not_available",
        }
        try:
            response = await _http.post(
                f"{SUPABASE_URL}/rest/v1/vitawatch_readings",
                headers=_supabase_reading_headers("return=representation"),
                json=payload,
                timeout=1.5,
            )
            if response.status_code < 300:
                rows = response.json() if response.content else []
                if rows:
                    return {"reading": rows[0]}
        except (httpx.HTTPError, ValueError):
            pass

    reading.update({"id": str(uuid4()), "device_id": DEVICE_ID})
    rows = _local_scan_readings()
    rows.insert(0, reading)
    _save_local_scan_readings(rows[:500])
    return {"reading": reading}


@app.delete("/api/device/readings/{reading_id}")
async def delete_device_reading(reading_id: str):
    if _can_command():
        try:
            response = await _http.delete(
                f"{SUPABASE_URL}/rest/v1/vitawatch_readings",
                params={
                    "id": f"eq.{reading_id}",
                    "device_id": f"eq.{DEVICE_ID}",
                },
                headers=_supabase_reading_headers("return=representation"),
                timeout=1.5,
            )
            if response.status_code < 300:
                rows = response.json() if response.content else []
                if rows:
                    return {"ok": True}
        except (httpx.HTTPError, ValueError):
            pass

    rows = _local_scan_readings()
    remaining = [row for row in rows if str(row.get("id")) != reading_id]
    if len(remaining) == len(rows):
        raise HTTPException(404, "Saved reading was not found")
    _save_local_scan_readings(remaining)
    return {"ok": True}


class CommandBody(BaseModel):
    command: str


@app.get("/api/device/command")
async def get_device_command(device_id: str = Query("esp32_jeevancare_01")):
    """Return the command from this local service for fast LAN polling."""
    return {"command": _current_command["cmd"]}


@app.post("/api/device/command")
async def device_command(body: CommandBody):
    if body.command not in VALID_COMMANDS:
        raise HTTPException(400, f"Unknown command. Use one of {sorted(VALID_COMMANDS)}")
    _current_command["cmd"] = body.command
    if not _can_command():
        return {"ok": True, "command": body.command, "synced_supabase": False}
    try:
        response = await _http.post(
            f"{SUPABASE_URL}/rest/v1/device_commands",
            params={"on_conflict": "device_id"},
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            json={"device_id": DEVICE_ID, "command": body.command, "issued_at": datetime.now(timezone.utc).isoformat()},
            timeout=1.5,
        )
        if response.status_code < 300:
            return {"ok": True, "command": body.command, "synced_supabase": True}
    except httpx.HTTPError:
        pass
    return {"ok": True, "command": body.command, "synced_supabase": False}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("VOICE_AGENT_PORT", "8001")), reload=True)




