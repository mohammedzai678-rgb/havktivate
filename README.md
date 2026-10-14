# Jeevan Voice Agent

A predictive voice companion for the **VitaWatch ESP32 hardware** (MAX30102 pulse/SpO₂, MAX30205 body
temperature, OLED; the scan flow uses MAX30102 and MAX30205 only). It learns the wearer's normal, forecasts what is coming, and **speaks first**
through a Bluetooth headset (ElevenLabs voice, Gemini wording) — e.g. *"Your heartbeat seems a little fast.
Are you feeling nervous?"* — then listens for the answer, guides breathing, and (only after a clear "yes")
prepares a caregiver message.

```
msrus/
├─ firmware/jeevancare_esp32/   ESP32 C/C++ firmware — identical to VitaWatch (same pins, same Wi‑Fi, same endpoint)
├─ server/                      Python (FastAPI): ESP32 link + ElevenLabs TTS + Gemini dialogue
└─ web/                         Vite + React + TypeScript: the single Voice Agent page
```

## Hardware (unchanged)
Same board, wiring and Wi‑Fi as before — see `firmware/jeevancare_esp32/config.h`.
The ESP32 sends live readings and receives scan commands directly from the laptop over Wi-Fi. Set LOCAL_BACKEND_BASE_URL in config.h to the laptop's current Wi-Fi IPv4 address. Keep the laptop and ESP32 on the same network; the server must be reachable on port 8001.

## Run it

**1. Server** (Python 3.10+)
```powershell
cd server
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env        # then fill in ELEVENLABS_API_KEY and GEMINI_API_KEY
.\.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```
Optional: configure the Supabase URL and service-role key in server/.env to sync telemetry and saved readings to the cloud. Sensor selection and reading history use the local service and remain available when Supabase is temporarily unreachable; offline readings are stored in server/data/scan_readings.json.

**2. Web**
```powershell
cd web
npm install
npm run dev                   # http://localhost:5173
```

**3. Headset**: pair the Bluetooth headset in Windows and set it as the default **input and output**,
open the page in Chrome, press **Start Voice Agent** (this unlocks audio so the agent may speak first).

## How the prediction works (all on the laptop, nothing learned in the cloud)
- **Learned pattern** – a personal baseline per vital (saved in the browser), updated only from non‑abnormal readings.
- **Time‑to‑event** – 60 s linear trend → "reaches attention level in ~N s (confidence %)".
- **Risk score** – 0–100 that climbs as precursors build, with a +60 s projection.
- **Speak first** – when the forecast/learned drift says something is coming, the agent opens the conversation, says *why*, then listens.
- **Adapts** – "I'm fine" makes it ask a little less about that topic next time; "not well" makes it ask sooner.

Complete HR/SpO2/temperature scans are saved to Supabase vitawatch_readings when server credentials are configured, or to server/data/scan_readings.json otherwise. Raw ESP32 samples continue to be logged to server/data/vitals_log.csv.

*Assistive early‑warning only — not a medical device, no diagnosis.*




