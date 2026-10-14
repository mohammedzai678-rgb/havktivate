# JeevanCare Operational Workflows

This document describes the three end-to-end workflows of the JeevanCare platform:
1. **Vital Signs Scanning & Telemetry Workflow**
2. **Automated Medicine Reminder & Clock Workflow**
3. **Proactive Conversational Voice Agent Workflow**

---

## 1. Vital Signs Scanning & Telemetry Workflow

```
[ User in Web App ]               [ Local Server ]               [ ESP32 Core 0 & Core 1 ]
        |                                |                                   |
        |--- 1. Click "Start Scan" ----->|                                   |
        |    POST /api/device/command    |                                   |
        |    command: "read_max30102"    |                                   |
        |                                |<--- 2. Stream POST (every 1s) ----|
        |                                |     Returns command in reply ---->|
        |                                |                                   |
        |                                |                        [ Core 1: Sensors ]
        |                                |                        - OLED: "PLACE FINGER"
        |                                |                        - 100Hz IR/Red sampling
        |                                |                        - Refractory beat filter
        |                                |                        - SpO2 calculation
        |                                |<--- 3. Live Vitals Stream --------|
        |<-- 4. Polls /api/device/status |        (HR: 75 bpm, SpO2: 98%)    |
        |    (Live values displayed)     |                                   |
        |                                |                                   |
        |--- 5. Click "Next: Temp" ----->|                                   |
        |    POST /api/device/command    |                                   |
        |    command: "read_dht11"       |----> Core 1 switches to MAX30205  |
        |                                       OLED: Core Temp 36.5 °C      |
        |                                |<--- Live Temp Stream (36.5 °C) ---|
        |<-- Fresh Temp Displayed -------|                                   |
        |                                |                                   |
        |--- 6. Click "Save Reading" --->|                                   |
        |    POST /api/device/readings   |----> Persisted to history         |
```

### Sensor Details:
- **MAX30102 (Pulse & SpO₂):** 
  - Finger presence verified via human tissue IR threshold (`ir > 35,000`).
  - Adaptive peak detection rejects dicrotic notch double-counting with a physiological refractory window (460 ms to 1350 ms).
  - Requires 3 consecutive verified beats before locking in heart rate and SpO₂.
- **MAX30205 (Clinical Body Temperature):**
  - Reads raw skin contact temperature directly over I2C at address `0x4C`.
  - Converts skin temperature to calibrated core temperature using clinical regression: `Core = 0.55 * T_skin + 19.30`.
  - Fallback to DHT11 ambient sensor if MAX30205 is not plugged in.

---

## 2. Automated Medicine Reminder & Clock Workflow

```
1. SETUP SCHEDULE:
   User enters schedule (e.g., Morning 08:00, Afternoon 14:00, Evening 20:00)
   via the Web UI inputs or spoken voice ("Morning 8 AM, Afternoon 2 PM, Evening 8 PM").
   Saved to local server storage via PUT /api/device/reminders.

2. REAL-TIME CLOCK CHECK:
   - Web application checks live clock every 2 seconds.
   - ESP32 tracks time using DS3231 RTC (I2C address 0x68) synced via NTP / local server.

3. REMINDER ACTIVATION (At exact scheduled minute):
   [ Web Dashboard ]
   ├── Audio: Rings a 3-tone chime (D5 - A5 - D6) using Web Audio API.
   ├── Voice: Speaks aloud: "Attention: It is time to take your morning medicine. Please take your prescribed pills."
   ├── Visual: Displays a prominent alert banner with "I Took My Medicine" action button.
   └── Network: Sends POST /api/device/reminders/active with { active: true, slot: "morning" }.

   [ ESP32 Hardware ]
   ├── Stream reply receives "reminder_led": true.
   ├── Hardware LED on GPIO 22 immediately turns ON (glowing).
   └── OLED Screen displays:
         *** REMINDER ***
             MEDICINE
         Take morning pills!
         Press button to clear

4. ACKNOWLEDGE & DISMISS (Turn Off LED):
   Either:
   A) User presses the hardware push button on the ESP32 (GPIO 21 or GPIO 27), OR
   B) User clicks "✓ I Took My Medicine (Turn Off LED)" on the web dashboard.
   Result:
   ├── GPIO 22 LED turns OFF immediately.
   ├── Alert banner dismisses.
   └── Voice confirms: "Medicine reminder acknowledged. Great job staying on track."
```

---

## 3. Proactive Conversational Voice Agent Workflow

```
1. SENSOR STREAMING & BASELINE LEARNING:
   Live vitals (HR, SpO2, Temperature) feed into the anticipation engine in the browser.
   The engine computes a running personal baseline (mean ± standard deviation) per vital.

2. EARLY-WARNING PROJECTION:
   Linear regression over a 60-second window computes rate-of-change and time-to-attention.
   A composite risk score (0..100) tracks physiological deviation before critical thresholds.

3. AGENT SPEAKS FIRST (Proactive Intervention):
   When a vital exhibits rapid change (e.g. rising heart rate):
   - Backend calls Gemini 3.8 Flash to compose a calm, culturally sensitive opening line in the wearer's language.
   - ElevenLabs TTS renders high-quality spoken audio through the headset.
   - Agent prompts: "Your heartbeat seems a little fast. Are you feeling nervous or restless?"

4. WEARER INTERACTION & ESCALATION:
   - Web speech recognition captures the wearer's spoken reply.
   - Gemini classifies intent:
     * "fine"   -> Acknowledges gently, remains in background standby.
     * "unwell" -> Offers guided slow breathing exercise (4-7-8 rhythm).
     * "help"   -> Prepares emergency caregiver WhatsApp/SMS notification for instant transmission.
