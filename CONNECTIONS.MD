# JeevanCare Hardware & Software Connections Specification

This document is the authoritative connection map for the **JeevanCare VitalWatch & Medicine Reminder Clock** hardware system based on the ESP32 DevKit (NodeMCU ESP32 / CP2102).

---

## 1. Master Pinout Table

| ESP32 Pin | Function / Direction | Connected Hardware | Module Pin | Voltage | Notes |
|---|---|---|---|---|---|
| **GPIO 19** | I2C SDA (Bidirectional) | OLED Display, MAX30102, MAX30205, DS3231 RTC | `SDA` | 3.3V | Shared primary I2C data bus |
| **GPIO 18** | I2C SCL (Output) | OLED Display, MAX30102, MAX30205, DS3231 RTC | `SCL` | 3.3V | Shared primary I2C clock bus |
| **GPIO 22** | Digital Output | Medicine Reminder LED | Anode (`+`) | 3.3V | Active HIGH; use 220Ω resistor to GND |
| **GPIO 21** | Digital Input | Medicine Acknowledge Button | Terminal 1 | 3.3V | `INPUT_PULLUP`; Terminal 2 to GND |
| **GPIO 27** | Digital Input | Screen / Secondary Acknowledge Button | Terminal 1 | 3.3V | `INPUT_PULLUP`; Terminal 2 to GND |
| **GPIO 4** | Digital I/O | DHT11 Temp/Humidity Sensor | `DATA` / `OUT` | 3.3V | Ambient backup sensor; 4.7kΩ pull-up |
| **GPIO 34** | Analog Input (ADC1) | AD8232 Single-Lead ECG | `OUTPUT` | 3.3V | Raw cardiac waveform (input only pin) |
| **GPIO 32** | Digital Input | AD8232 Single-Lead ECG | `LO +` | 3.3V | Lead-off detect positive |
| **GPIO 33** | Digital Input | AD8232 Single-Lead ECG | `LO -` | 3.3V | Lead-off detect negative |
| **3.3V** | Power Output | All Sensor Boards | `VCC` / `VIN` | 3.3V | Direct regulated 3.3V rail |
| **GND** | Ground | All Modules, Buttons, LED | `GND` | 0V | Common shared ground rail |

---

## 2. Shared I2C Bus Topology (GPIO 19 SDA, GPIO 18 SCL)

Four separate peripherals communicate concurrently over the same two I2C lines:

```
               +---------------------------------------+
               |        ESP32 DevKit Controller        |
               |       GPIO 19 (SDA)   GPIO 18 (SCL)   |
               +-------------------+---------------+---+
                                   |               |
         +-------------------------+---------------+-------------------------+
         |                         |               |                         |
         v                         v               v                         v
+-----------------+       +-----------------+     +-----------------+       +-----------------+
|   SSD1306 OLED  |       | MAX30102 Pulse  |     | MAX30205 Body   |       | DS3231 RTC      |
|     Display     |       |   & SpO2 PPG    |     |   Temperature   |       | Clock + Battery |
|  Address: 0x3C  |       |  Address: 0x57  |     |  Address: 0x4C  |       |  Address: 0x68  |
+-----------------+       +-----------------+     +-----------------+       +-----------------+
```

### I2C Address Map
- **`0x3C`**: 0.96" SSD1306 Monochrome OLED Display (128x64 pixels).
- **`0x57`**: SparkFun MAX30102 Pulse Oximeter & Heart Rate Photoplethysmogram sensor.
- **`0x4C`** *(range 0x48–0x4F)*: CJMCU-30205 Clinical Body Temperature sensor (0.1 °C medical accuracy).
- **`0x68`**: DS3231 High-Precision Real-Time Clock with CR2032 coin cell backup battery.

> **Wiring Tip:** All four I2C devices connect in parallel: all `SDA` pins join to ESP32 GPIO 19, and all `SCL` pins join to ESP32 GPIO 18. All sensors share the common 3.3V and GND rails.

---

## 3. Power Supply Rules

1. **Supply Voltage:** All sensor modules (MAX30102, MAX30205, OLED, DHT11) must be connected to the ESP32's **3.3V** pin. Do not connect sensor `VCC` to `VIN` or `5V`, as excessive voltage will damage the I2C transceivers.
2. **Common Ground:** Every component, including the push buttons and the LED cathode, must tie into the same common `GND` rail.
3. **RTC Backup Battery:** The DS3231 module requires a coin cell (CR2032) inserted into its battery holder to retain real-time clock tracking when the ESP32 is powered off.

---

## 4. Software & Network Endpoints (Port 8001)

The ESP32 communicates with the local Python backend over Wi-Fi using non-blocking HTTP REST:

| Endpoint | Method | Sender | Purpose |
|---|---|---|---|
| `/api/device/live-stream` | `POST` | ESP32 | Transmits active sensor telemetry every 1 s; returns current command and active reminder status in reply |
| `/api/device/status` | `GET` | Web Dashboard | Retrieves live device online status, active sensor, and freshest metrics |
| `/api/device/command` | `POST` | Web Dashboard | Changes active sensor mode: `idle`, `read_max30102`, `read_dht11`, `read_ad8232` |
| `/api/device/reminders` | `GET` / `PUT` | Web Dashboard | Reads and updates scheduled reminder times (`morning`, `afternoon`, `evening`) |
| `/api/device/reminders/active` | `GET` / `POST` | Dashboard / ESP32 | Triggers or checks active reminder state (`active: true/false`, `slot`) |
| `/api/device/reminders/acknowledge` | `POST` | Dashboard / ESP32 | Clears active reminder alert and switches off the indicator LED |
| `/api/device/readings` | `GET` / `POST` / `DELETE`| Dashboard | Saves, lists, or deletes recorded patient vitals |

---

## 5. ESP32 #2 — Walking Stick Hardware Specification

The walking stick operates on a **second, independent ESP32 DevKit** running `firmware/walking_stick_esp32/walking_stick_esp32.ino`. It connects to the same local Wi-Fi and Python backend as ESP32 #1 (VitaWatch).

### Master Pinout Table (Walking Stick)

| ESP32 Pin | Function / Direction | Connected Hardware | Module Pin | Voltage | Circuit / Wiring Details |
|---|---|---|---|---|---|
| **GPIO 33** | Analog Input (ADC1) | LDR Light Sensor | Leg 2 & 4.7 kΩ junction | 0 – 3.3V | Voltage divider: 3V3 → LDR → GPIO 33 → 4.7 kΩ resistor → GND |
| **GPIO 2** | Digital Output | External Indicator LED | 220 Ω resistor input | 3.3V Logic | GPIO 2 → 220 Ω resistor → LED Anode (long leg); Cathode (short leg) → GND |
| **GPIO 5** | Digital Output | Ultrasonic Sensor 1 (Left) | `TRIG` | 3.3V Logic | Direct 10µs trigger pulse to HC-SR04 |
| **GPIO 34** | Digital Input (Input-Only) | Ultrasonic Sensor 1 (Left) | `ECHO` | 3.3V Safe | Voltage divider: Sensor ECHO → 1 kΩ → GPIO 34 → 2 kΩ → GND |
| **GPIO 18** | Digital Output | Ultrasonic Sensor 2 (Front) | `TRIG` | 3.3V Logic | Direct 10µs trigger pulse to HC-SR04 |
| **GPIO 35** | Digital Input (Input-Only) | Ultrasonic Sensor 2 (Front) | `ECHO` | 3.3V Safe | Voltage divider: Sensor ECHO → 1 kΩ → GPIO 35 → 2 kΩ → GND |
| **GPIO 19** | Digital Output | Ultrasonic Sensor 3 (Right) | `TRIG` | 3.3V Logic | Direct 10µs trigger pulse to HC-SR04 |
| **GPIO 32** | Digital Input | Ultrasonic Sensor 3 (Right) | `ECHO` | 3.3V Safe | Voltage divider: Sensor ECHO → 1 kΩ → GPIO 32 → 2 kΩ → GND |
| **VIN / 5V** | Power Rail | 3x HC-SR04 Ultrasonic Sensors | `VCC` | 5.0V | Powers 5V acoustic transducers |
| **3.3V** | Power Rail | LDR Sensor Voltage Divider | Leg 1 | 3.3V | Safe ADC input rail |
| **GND** | Ground Rail | LDR, LED, 3x HC-SR04 Sensors | `GND` | 0V | Common shared ground for all components |

---

### Detailed Subsystem Wiring

#### A. LDR Light Sensor (Dark Detection)
- **LDR Leg 1:** Connect to ESP32 **3V3**.
- **LDR Leg 2:** Connect to ESP32 **GPIO 33**.
- **4.7 kΩ Resistor Leg 1:** Connect to the same junction on ESP32 **GPIO 33**.
- **4.7 kΩ Resistor Leg 2:** Connect to ESP32 **GND**.
- *Operation:* When dark, LDR resistance surges (> 100 kΩ), pulling GPIO 33 voltage down towards GND (< threshold). In bright light, resistance drops (< 1 kΩ), pulling GPIO 33 voltage up towards 3.3V (> threshold).

#### B. External LED
- **ESP32 GPIO 2:** Connect to one leg of the **220 Ω resistor**.
- **220 Ω Resistor (other end):** Connect to **LED Anode** (longer lead / `+`).
- **LED Cathode (shorter lead / `-`):** Connect to ESP32 **GND**.
- *Safety Note:* Keep the 220 Ω LED current-limiting resistor completely separate from the 4.7 kΩ LDR divider resistor. Do not attach high-power AC lamps directly to GPIO 2; use an optocoupled relay or MOSFET power stage for heavy loads.

#### C. 3x Ultrasonic Echo Voltage Dividers (5V → 3.3V Protection)
Each HC-SR04 generates a 5V echo return pulse. Because ESP32 GPIOs tolerate maximum 3.3V, use a 1 kΩ / 2 kΩ divider (or 1 kΩ / 2.2 kΩ) on each echo line:
```
HC-SR04 ECHO (5V) ───[ 1 kΩ ]───┬───> ESP32 GPIO (34 / 35 / 32)
                                │
                             [ 2 kΩ ]
                                │
                               GND
```
- **Sensor 1 (Left):** TRIG → GPIO 5, ECHO midpoint → GPIO 34
- **Sensor 2 (Front):** TRIG → GPIO 18, ECHO midpoint → GPIO 35
- **Sensor 3 (Right):** TRIG → GPIO 19, ECHO midpoint → GPIO 32
- **All 3 Sensors:** VCC → VIN (5V), GND → Common GND

---

### Walking Stick Network Endpoints (Port 8001)

| Endpoint | Method | Sender | Purpose |
|---|---|---|---|
| `/api/stick/telemetry` | `POST` | Walking Stick ESP32 | Streams Left/Front/Right distances, contact state, LDR value, and LED state every 1 s |
| `/api/stick/event` | `POST` | Walking Stick ESP32 | Transmits critical events to be spoken aloud by Voice Agent (e.g. "Obstacle on right. Take left", "The room is dark. Turning on light") |
| `/api/stick/status` | `GET` | Web Dashboard | Retrieves current walking stick metrics and online status |
| `/api/stick/events` | `GET` | Web Dashboard | Polls new spoken guidance queue to synthesize through ElevenLabs / Web Speech |
