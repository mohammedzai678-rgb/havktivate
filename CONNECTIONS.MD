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
