# How to Run the JeevanCare Stack

Follow this exact sequence to start and run the JeevanCare platform (Backend Server, Web Application, and ESP32 Hardware).

---

## Prerequisites & Wi-Fi Check

1. Turn on your mobile hotspot or connect your laptop to the local Wi-Fi router.
2. In PowerShell, find your laptop's current local IPv4 address:
   ```powershell
   ipconfig
   ```
   Note the `IPv4 Address` under your active Wi-Fi adapter (e.g., `10.236.84.35`).
3. If this address ever changes, update line 12 of `firmware/jeevancare_esp32/config.h`:
   ```c
   #define LOCAL_BACKEND_BASE_URL "http://YOUR_LAPTOP_IP:8001"
   ```
   and upload the firmware to the ESP32.

---

## Step 1: Start the Local Backend Server (Port 8001)

Open a PowerShell terminal:

```powershell
cd C:\Users\moham\Desktop\msrus\server
.\.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8001
```

> **Important:** Do **not** use `--reload`. Running without `--reload` ensures clean single-process binding to port 8001 and avoids background ghost processes.

Verify the server is running by opening: [http://localhost:8001/health](http://localhost:8001/health).

---

## Step 2: Start the Web Dashboard (Port 5173)

Open a second PowerShell terminal:

```powershell
cd C:\Users\moham\Desktop\msrus\web
npm run dev
```

Open your browser to: **[http://localhost:5173](http://localhost:5173)**.

---

## Step 3: Power or Upload the ESP32 Firmware

The ESP32 firmware is unified in a single sketch:
`firmware/jeevancare_esp32/jeevancare_esp32.ino`

- **To upload via Arduino IDE:**
  1. Open `firmware/jeevancare_esp32/jeevancare_esp32.ino`.
  2. Select your board (**ESP32 Dev Module**) and connected COM port (e.g., `COM5`).
  3. Click **Upload**.
- **Once uploaded:**
  Simply keep the ESP32 plugged into USB for power. It will automatically connect to Wi-Fi and start streaming telemetry to your backend.

---

## Step 4: Using the Features

### 1. Medicine Reminders (Automated Voice & LED)
- Under **Medicine reminders**, enter your scheduled times (e.g. `08:00`, `14:00`, `20:00`) or click **🎙 Set times by voice** to speak them aloud.
- Click **Save reminder times**.
- **Instant Test:** Click the orange **`🔔 Test Voice & LED`** button. The web app will ring a 3-tone chime, speak the reminder aloud through your speakers, and illuminate the ESP32's LED on GPIO 22.
- **Dismissing an Alert:** Click **`✓ I Took My Medicine`** on screen or press the hardware push button on the ESP32 (GPIO 21 or GPIO 27) to turn off the LED.

### 2. Live Vital Signs Scan
- Under **Sensor scan & readings**, click **▶ Start Full Scan** (or select **MAX30102 · Pulse / SpO₂**).
- Place your finger steadily on the MAX30102 sensor. The OLED will display your live pulse wave, heart rate (BPM), and blood oxygen (SpO₂).
- The scan will transition to the MAX30205 clinical temperature sensor (reading at address `0x4C`).
- Click **Record & Finish Scan** to save the reading to your history log.

---

## Offline Data & Privacy
- Telemetry, sensor commands, and medicine reminders run 100% locally on your network without needing cloud access.
- Cloud syncing to Supabase is optional and best-effort.
- Voice AI features (conversational companion via Gemini and natural speech via ElevenLabs) use their configured keys in `server/.env`.
