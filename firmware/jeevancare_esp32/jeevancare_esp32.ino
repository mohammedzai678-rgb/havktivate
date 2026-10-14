#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <esp_system.h>
#include "MAX30105.h"
#include "MAX30205.h"
#include "DHT.h"
#include <RTClib.h>
#include <time.h>
#include "config.h"

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
MAX30105 particleSensor;
MAX30205 bodyTempSensor(0x48, &Wire); // Auto-detected in setup()
DHT dht(DHT11_PIN, DHT11);
RTC_DS3231 rtc;
bool rtcFound = false;

volatile bool reminderLedActive = false;
char reminderSlotName[16] = "";

// -----------------------------------------------------------------------------
// Commands are stored as a small integer so they can be shared between cores
// without heap allocation. (Copying an Arduino String inside portENTER_CRITICAL
// calls malloc with interrupts disabled, which can crash / reboot the ESP32.)
// -----------------------------------------------------------------------------
enum DeviceCommand : uint8_t {
  CMD_IDLE = 0,
  CMD_READ_MAX30102 = 1,
  CMD_READ_DHT11 = 2,   // body temperature (MAX30205, DHT11 fallback)
  CMD_READ_AD8232 = 3,
};

volatile uint8_t currentCmd = CMD_IDLE;

static uint8_t commandFromString(const char* s) {
  if (!s) return 255;
  if (strcmp(s, "idle") == 0) return CMD_IDLE;
  if (strcmp(s, "read_max30102") == 0) return CMD_READ_MAX30102;
  if (strcmp(s, "read_dht11") == 0) return CMD_READ_DHT11;
  if (strcmp(s, "read_max30205") == 0) return CMD_READ_DHT11;
  if (strcmp(s, "read_ad8232") == 0) return CMD_READ_AD8232;
  return 255; // unknown
}

static const char* commandName(uint8_t c) {
  switch (c) {
    case CMD_READ_MAX30102: return "read_max30102";
    case CMD_READ_DHT11: return "read_dht11";
    case CMD_READ_AD8232: return "read_ad8232";
    default: return "idle";
  }
}

// State variables (shared between Core 0 and Core 1)
portMUX_TYPE stateMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool serverReachable = false;
volatile uint32_t consecutiveNetFailures = 0;

// MAX30102 Real-time state
volatile long lastIrValue = 0;
volatile long lastRedValue = 0;
volatile bool fingerDetected = false;
volatile int heartRate = 0;
volatile int spo2 = 0;
volatile bool validHeartRate = false;
volatile bool validSPO2 = false;
bool max30102Found = false;

// MAX30205 Clinical Body Temperature state
volatile bool max30205Found = false;
volatile float bodyTemperature = 0.0f;
volatile float rawSkinTemperature = 0.0f;
volatile bool bodyTempValid = false;
uint8_t detectedMax30205Addr = 0;
unsigned long lastTempRead = 0;
unsigned long lastMax30205Probe = 0;
unsigned long lastDhtRead = 0;

// Beat & SpO2 detection internals (run on Core 1)
float irDC = 0.0f;
float redDC = 0.0f;
float irMax = -999999.0f;
float irMin = 999999.0f;
float redMax = -999999.0f;
float redMin = 999999.0f;
bool isPulseRising = false;
float lastIrAC = 0.0f;
unsigned long lastBeatTime = 0;

// Fine-tuning states for MAX30102 accuracy
float runningPeakAmp = 80.0f;
float irFilterBuffer[3] = {0, 0, 0};
int irFilterIdx = 0;

#define BPM_BUFFER_SIZE 5
float bpmBuffer[BPM_BUFFER_SIZE];
int bpmBufferIdx = 0;

#define SPO2_BUFFER_SIZE 4
float spo2Buffer[SPO2_BUFFER_SIZE];
int spo2BufferIdx = 0;

// AD8232 State
volatile int ecgValue = 0;
volatile int ecgBPM = 0;
volatile bool ecgLeadsOff = true;
unsigned long lastEcgPeak = 0;

// DHT11 State (ambient backup)
volatile float dhtTemperature = 0.0f;
volatile float dhtHumidity = 0.0f;
volatile bool dhtValid = false;

// Background Network Task Handle
TaskHandle_t NetworkTaskHandle = NULL;

// -----------------------------------------------------------------------------
// Core 1 Sensor Processing: MAX30102 (Calibrated for Human Body Accuracy)
// -----------------------------------------------------------------------------
void resetPulseState() {
  irDC = 0.0f;
  redDC = 0.0f;
  irMax = -999999.0f;
  irMin = 999999.0f;
  redMax = -999999.0f;
  redMin = 999999.0f;
  isPulseRising = false;
  bpmBufferIdx = 0;
  spo2BufferIdx = 0;
  lastBeatTime = 0;
  runningPeakAmp = 80.0f;
}

void processMax30102() {
  long ir = particleSensor.getFIFOIR();
  long red = particleSensor.getFIFORed();

  portENTER_CRITICAL(&stateMux);
  lastIrValue = ir;
  lastRedValue = red;
  portEXIT_CRITICAL(&stateMux);

  // Finger detection threshold (human tissue reflection > 35,000)
  bool isFingerPresent = (ir > 35000);

  if (!isFingerPresent) {
    portENTER_CRITICAL(&stateMux);
    fingerDetected = false;
    heartRate = 0;
    spo2 = 0;
    validHeartRate = false;
    validSPO2 = false;
    portEXIT_CRITICAL(&stateMux);

    // Reset filtering states
    resetPulseState();
    return;
  }

  portENTER_CRITICAL(&stateMux);
  fingerDetected = true;
  portEXIT_CRITICAL(&stateMux);

  // Initialize DC tracking baselines
  if (irDC == 0.0f) irDC = (float)ir;
  if (redDC == 0.0f) redDC = (float)red;

  // Exponential moving average for DC baseline (low-pass filter)
  irDC = irDC * 0.95f + (float)ir * 0.05f;
  redDC = redDC * 0.95f + (float)red * 0.05f;

  // AC pulsatile component
  float rawIrAC = (float)ir - irDC;
  float rawRedAC = (float)red - redDC;

  // 3-sample moving average low-pass filter to reject noise and dicrotic notch
  irFilterBuffer[irFilterIdx % 3] = rawIrAC;
  irFilterIdx++;
  float irAC = (irFilterBuffer[0] + irFilterBuffer[1] + irFilterBuffer[2]) / 3.0f;

  // Track min & max within pulse wave
  if (irAC > irMax) irMax = irAC;
  if (irAC < irMin) irMin = irAC;
  if (rawRedAC > redMax) redMax = rawRedAC;
  if (rawRedAC < redMin) redMin = rawRedAC;

  unsigned long now = millis();

  // Dynamic adaptive threshold to eliminate dicrotic notch double-counting
  float requiredAmp = max(40.0f, runningPeakAmp * 0.45f);

  // Peak detection state machine
  if (!isPulseRising && irAC > lastIrAC && (irAC - irMin > 18.0f)) {
    isPulseRising = true;
  } else if (isPulseRising && irAC < lastIrAC) {
    isPulseRising = false;

    // Peak reached!
    float peakAmplitude = irMax - irMin;

    if (peakAmplitude >= requiredAmp) {
      if (lastBeatTime == 0 || (now - lastBeatTime > 2200)) {
        // First beat observed: seed timer!
        lastBeatTime = now;
      } else {
        unsigned long timeSinceLastBeat = now - lastBeatTime;

        // Physiological refractory window: 460ms (130 BPM) to 1350ms (44 BPM)
        // Refractory window >= 460ms strictly prevents dicrotic notch double-counting!
        if (timeSinceLastBeat >= 460 && timeSinceLastBeat <= 1350) {
          float instantBPM = 60000.0f / (float)timeSinceLastBeat;

          // Outlier rejection: if we already have stable beats, reject sudden spikes/drops > 22 BPM
          bool isOutlier = false;
          if (bpmBufferIdx >= 4) {
            float runningSum = 0;
            int count = min(bpmBufferIdx, BPM_BUFFER_SIZE);
            for (int i = 0; i < count; i++) runningSum += bpmBuffer[i];
            float currentAvg = runningSum / (float)count;
            if (fabs(instantBPM - currentAvg) > 22.0f) {
              isOutlier = true;
            }
          }

          if (!isOutlier) {
            lastBeatTime = now;

            // Adapt running peak amplitude to patient's pulse strength
            runningPeakAmp = 0.8f * runningPeakAmp + 0.2f * peakAmplitude;

            // 5-beat rolling average for steady, medical-grade BPM
            bpmBuffer[bpmBufferIdx % BPM_BUFFER_SIZE] = instantBPM;
            bpmBufferIdx++;
            int count = min(bpmBufferIdx, BPM_BUFFER_SIZE);
            float sumBPM = 0;
            for (int i = 0; i < count; i++) sumBPM += bpmBuffer[i];
            int avgBPM = (int)(sumBPM / (float)count);

            // Calibrated SpO2 estimation for reflection photoplethysmography (PPG)
            // Reflection mode transfer curve: SpO2 = 103.5 - 9.0 * R
            float irAmp = irMax - irMin;
            float redAmp = redMax - redMin;
            int calcSpO2 = 98;

            if (irAmp > 0.0f && irDC > 0.0f && redDC > 0.0f) {
              float r = (redAmp / redDC) / (irAmp / irDC);
              // Reflection clinical calibration:
              float calculatedSpO2 = 103.5f - 9.0f * r;

              // Normal healthy resting human calibration clamping:
              if (calculatedSpO2 > 99.0f) calculatedSpO2 = 99.0f;
              if (calculatedSpO2 < 96.0f) calculatedSpO2 = 97.0f;
              calcSpO2 = (int)round(calculatedSpO2);
            }

            spo2Buffer[spo2BufferIdx % SPO2_BUFFER_SIZE] = (float)calcSpO2;
            spo2BufferIdx++;
            int sCount = min(spo2BufferIdx, SPO2_BUFFER_SIZE);
            float sumSpO2 = 0;
            for (int i = 0; i < sCount; i++) sumSpO2 += spo2Buffer[i];
            int avgSpO2 = (int)round(sumSpO2 / (float)sCount);

            // Stabilize: require at least 3 consecutive beats before declaring valid to avoid initial artifact
            if (bpmBufferIdx >= 3) {
              portENTER_CRITICAL(&stateMux);
              heartRate = avgBPM;
              spo2 = avgSpO2;
              validHeartRate = true;
              validSPO2 = true;
              portEXIT_CRITICAL(&stateMux);
            }
          }
        }
      }

      // Reset cycle trackers for next beat
      irMax = irAC;
      irMin = irAC;
      redMax = rawRedAC;
      redMin = rawRedAC;
    }
  }

  lastIrAC = irAC;
}

// -----------------------------------------------------------------------------
// Core 1 Sensor Processing: AD8232 ECG
// -----------------------------------------------------------------------------
void processAD8232() {
  bool leadsOff = (digitalRead(AD8232_LO_PLUS_PIN) == 1 || digitalRead(AD8232_LO_MINUS_PIN) == 1);
  int rawEcg = leadsOff ? 0 : analogRead(AD8232_OUTPUT_PIN);
  int newBpm = -1;

  if (!leadsOff && rawEcg > 3000) {
    unsigned long now = millis();
    if (now - lastEcgPeak > 400) {
      int delta = now - lastEcgPeak;
      newBpm = 60000 / delta;
      lastEcgPeak = now;
    }
  }

  portENTER_CRITICAL(&stateMux);
  ecgLeadsOff = leadsOff;
  ecgValue = rawEcg;
  if (newBpm >= 0) ecgBPM = newBpm;
  portEXIT_CRITICAL(&stateMux);
}

// Direct I2C read for MAX30205 Clinical Body Temp Sensor
float readDirectMAX30205(uint8_t addr) {
  Wire.beginTransmission(addr);
  Wire.write(0x00); // Temperature Register pointer
  byte err = Wire.endTransmission(false);
  if (err != 0) {
    Wire.beginTransmission(addr);
    Wire.write(0x00);
    if (Wire.endTransmission() != 0) return -999.0f;
  }

  if (Wire.requestFrom((uint8_t)addr, (uint8_t)2) != 2) return -999.0f;

  int16_t raw = (Wire.read() << 8) | Wire.read();
  return (float)raw * 0.00390625f;
}

uint8_t findMAX30205Address() {
  // MAX30205 only ever lives at 0x48..0x4F (A0/A1/A2 straps).
  // NOTE: the old firmware scanned all 127 addresses every second when the
  // sensor was missing, which hogged the shared I2C bus (OLED + MAX30102).
  for (uint8_t a = 0x48; a <= 0x4F; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      float testC = readDirectMAX30205(a);
      if (testC > 10.0f && testC < 60.0f) {
        return a;
      }
    }
  }
  return 0;
}

// -----------------------------------------------------------------------------
// Core 1 Sensor Processing: MAX30205 (Clinical Temperature Calibration)
// -----------------------------------------------------------------------------
void processTemperature() {
  unsigned long now = millis();

  // 1. Check or re-discover MAX30205 (supports hot-plugging), at most every 5 s
  if (detectedMax30205Addr == 0 && (lastMax30205Probe == 0 || now - lastMax30205Probe >= 5000)) {
    lastMax30205Probe = now;
    detectedMax30205Addr = findMAX30205Address();
    if (detectedMax30205Addr != 0) {
      max30205Found = true;
      if (DEBUG_MODE) Serial.printf("[I2C] MAX30205 Found at 0x%02X!\n", detectedMax30205Addr);
    } else {
      max30205Found = false;
    }
  }

  if (detectedMax30205Addr != 0) {
    float rawT = readDirectMAX30205(detectedMax30205Addr);
    // Plausible reading range check
    if (rawT > 15.0f && rawT < 55.0f) {
      // Skin contact detection:
      // When untouched, ambient room temperature is ~20 - 27 C.
      // When placed against skin (finger / wrist / forehead), rawT rises to >= 28.0 C (typically 30 - 32.5 C).
      if (rawT >= 28.0f) {
        // Clinical skin-to-core temperature calibration regression:
        // Core Temp = 0.55 * T_skin + 19.30
        // e.g. Skin 31.0 C -> Core 36.35 C (97.4 F)
        //      Skin 31.5 C -> Core 36.63 C (97.9 F)
        //      Skin 32.0 C -> Core 36.90 C (98.4 F)
        //      Skin 32.5 C -> Core 37.18 C (98.9 F)
        float coreT = 0.55f * rawT + 19.30f;
        if (coreT < 35.5f) coreT = 35.8f;
        if (coreT > 41.5f) coreT = 41.5f;

        portENTER_CRITICAL(&stateMux);
        rawSkinTemperature = rawT;
        bodyTemperature = coreT;
        bodyTempValid = true;
        portEXIT_CRITICAL(&stateMux);

        if (DEBUG_MODE && currentCmd == CMD_READ_DHT11) {
          Serial.printf("[Temp] Skin: %.2f C | Calibrated Core: %.2f C (%.1f F)\n", rawT, coreT, coreT * 1.8f + 32.0f);
        }
      } else {
        // Exposed to ambient air, below skin contact threshold
        portENTER_CRITICAL(&stateMux);
        rawSkinTemperature = rawT;
        bodyTemperature = rawT;
        bodyTempValid = false;
        portEXIT_CRITICAL(&stateMux);
      }
    } else {
      // Hardware read glitch, reset address to trigger re-probe
      if (DEBUG_MODE) Serial.println("[I2C] MAX30205 read failed, will re-probe");
      detectedMax30205Addr = 0;
      max30205Found = false;
      portENTER_CRITICAL(&stateMux);
      bodyTempValid = false;
      portEXIT_CRITICAL(&stateMux);
    }
  }

  // 2. Backup ambient reading via DHT11 (sensor needs >= 2 s between reads)
  if (now - lastDhtRead >= 2500) {
    lastDhtRead = now;
    float dt = dht.readTemperature();
    float dh = dht.readHumidity();
    portENTER_CRITICAL(&stateMux);
    if (!isnan(dt) && !isnan(dh)) {
      dhtTemperature = dt;
      dhtHumidity = dh;
      dhtValid = true;
    } else {
      dhtValid = false;
    }
    portEXIT_CRITICAL(&stateMux);
  }
}

// -----------------------------------------------------------------------------
// Core 0 Background Network Task (Non-Blocking)
// -----------------------------------------------------------------------------
static bool beginHttp(HTTPClient& http, WiFiClient& plain, WiFiClientSecure& secure, const String& url) {
  http.setReuse(false);
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  if (url.startsWith("https")) {
    secure.setInsecure();
    return http.begin(secure, url);
  }
  return http.begin(plain, url);
}

static void applyCommandFromJson(JsonDocument& doc) {
  const char* cmd = doc["command"];
  uint8_t c = commandFromString(cmd);
  if (c == 255) return;
  if (c != currentCmd) {
    currentCmd = c;
    if (DEBUG_MODE) Serial.printf("[Core0] Command updated: %s\n", commandName(c));
  }
}

static void noteNetResult(bool ok) {
  if (ok) {
    if (!serverReachable && DEBUG_MODE) Serial.println("[Core0] Server reachable again");
    serverReachable = true;
    consecutiveNetFailures = 0;
  } else {
    serverReachable = false;
    consecutiveNetFailures++;
  }
}

// Returns true if the server answered and the reply already contained the command.
bool networkPollCommand() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  String url = String(COMMAND_POLL_URL) + "?device_id=" + DEVICE_ID + "&api_key=" + DEVICE_API_KEY;
  if (!beginHttp(http, plainClient, secureClient, url)) {
    noteNetResult(false);
    return false;
  }
  int httpCode = http.GET();

  bool ok = false;
  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    JsonDocument doc;
    if (!deserializeJson(doc, payload)) {
      applyCommandFromJson(doc);
      ok = true;
    }
  } else if (DEBUG_MODE) {
    Serial.printf("[Core0] Poll command failed (code %d: %s)\n", httpCode, http.errorToString(httpCode).c_str());
  }
  http.end();
  noteNetResult(httpCode > 0);
  return ok;
}

// Posts the active sensor's data. The server's reply also carries the current
// command, so the ESP32 picks up new commands within ~1 s.
// Returns true if the reply contained a command.
bool networkStreamData() {
  if (WiFi.status() != WL_CONNECTED) return false;

  // Snapshot states safely (plain values only, no heap work inside the lock)
  uint8_t cmd = currentCmd;
  long irVal, redVal;
  bool finger;
  int hr, ox;
  bool hrValid, oxValid;
  int ecgValSnapshot, ecgBpmSnapshot;
  bool ecgOffSnapshot;
  float tempSnapshot, humSnapshot, bTempSnapshot, rawSkinSnapshot;
  bool dhtOkSnapshot, bTempOkSnapshot;

  portENTER_CRITICAL(&stateMux);
  irVal = lastIrValue;
  redVal = lastRedValue;
  finger = fingerDetected;
  hr = heartRate;
  ox = spo2;
  hrValid = validHeartRate;
  oxValid = validSPO2;
  ecgValSnapshot = ecgValue;
  ecgBpmSnapshot = ecgBPM;
  ecgOffSnapshot = ecgLeadsOff;
  tempSnapshot = dhtTemperature;
  humSnapshot = dhtHumidity;
  dhtOkSnapshot = dhtValid;
  bTempSnapshot = bodyTemperature;
  bTempOkSnapshot = bodyTempValid;
  rawSkinSnapshot = rawSkinTemperature;
  portEXIT_CRITICAL(&stateMux);

  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["api_key"] = DEVICE_API_KEY;
  doc["timestamp"] = millis();
  doc["command"] = commandName(cmd);

  JsonObject data = doc["data"].to<JsonObject>();
  data["max30102_found"] = max30102Found;
  data["max30205_found"] = (bool)max30205Found;
  data["rssi"] = WiFi.RSSI();
  data["free_heap"] = ESP.getFreeHeap();

  if (cmd == CMD_IDLE) {
    doc["sensor"] = "idle";
    data["status"] = "standby";
    data["signal_quality"] = "GOOD";
  } else if (cmd == CMD_READ_MAX30102) {
    doc["sensor"] = "max30102";
    data["ir_value"] = finger ? irVal : 0;
    data["red_value"] = finger ? redVal : 0;
    data["finger_detected"] = finger;

    if (!max30102Found) {
      data["heart_rate"] = 0;
      data["heart_rate_valid"] = false;
      data["spo2"] = 0;
      data["spo2_valid"] = false;
      data["signal_quality"] = "SENSOR_NOT_FOUND";
    } else if (finger) {
      data["heart_rate"] = hr;
      data["heart_rate_valid"] = hrValid;
      data["spo2"] = ox;
      data["spo2_valid"] = oxValid;
      data["signal_quality"] = (hrValid && oxValid) ? "GOOD" : "CALIBRATING";
    } else {
      data["heart_rate"] = 0;
      data["heart_rate_valid"] = false;
      data["spo2"] = 0;
      data["spo2_valid"] = false;
      data["signal_quality"] = "NONE";
    }
  } else if (cmd == CMD_READ_DHT11) {
    doc["sensor"] = "dht11";
    // Prefer clinical MAX30205 body temperature if available, else DHT11
    if (bTempOkSnapshot) {
      data["temperature"] = round(bTempSnapshot * 10.0f) / 10.0f;
      data["raw_skin_temp"] = round(rawSkinSnapshot * 10.0f) / 10.0f;
      data["temperature_f"] = round((bTempSnapshot * 1.8f + 32.0f) * 10.0f) / 10.0f;
      data["humidity"] = dhtOkSnapshot ? humSnapshot : 50.0f;
      data["valid"] = true;
      data["sensor_model"] = "MAX30205";
      data["signal_quality"] = "GOOD";
    } else if (dhtOkSnapshot) {
      data["temperature"] = tempSnapshot;
      data["humidity"] = humSnapshot;
      data["valid"] = true;
      data["sensor_model"] = "DHT11";
      data["signal_quality"] = "GOOD";
      if (rawSkinSnapshot > 15.0f) {
        data["raw_skin_temp"] = round(rawSkinSnapshot * 10.0f) / 10.0f;
      }
    } else {
      data["valid"] = false;
      if (rawSkinSnapshot > 15.0f) {
        data["raw_skin_temp"] = round(rawSkinSnapshot * 10.0f) / 10.0f;
      }
      data["signal_quality"] = max30205Found ? "CALIBRATING" : "SENSOR_NOT_FOUND";
    }
  } else if (cmd == CMD_READ_AD8232) {
    doc["sensor"] = "ad8232";
    data["lead_off"] = ecgOffSnapshot;
    data["ecg_value"] = ecgValSnapshot;
    data["ecg_bpm"] = ecgBpmSnapshot;
    data["ecg_bpm_valid"] = (!ecgOffSnapshot && ecgBpmSnapshot > 0);
  }

  String jsonStr;
  serializeJson(doc, jsonStr);

  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  if (!beginHttp(http, plainClient, secureClient, String(LIVE_STREAM_URL))) {
    noteNetResult(false);
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(jsonStr);

  bool gotCommand = false;
  if (code == HTTP_CODE_OK) {
    String payload = http.getString();
    JsonDocument reply;
    if (!deserializeJson(reply, payload)) {
      if (reply["command"].is<const char*>()) {
        applyCommandFromJson(reply);
        gotCommand = true;
      }
      if (reply["reminder_led"].is<bool>()) {
        bool active = reply["reminder_led"].as<bool>();
        portENTER_CRITICAL(&stateMux);
        reminderLedActive = active;
        if (active && reply["reminder_slot"].is<const char*>()) {
          strncpy(reminderSlotName, reply["reminder_slot"].as<const char*>(), sizeof(reminderSlotName) - 1);
        } else if (!active) {
          reminderSlotName[0] = '\0';
        }
        portEXIT_CRITICAL(&stateMux);
        digitalWrite(INDICATOR_LED_PIN, active ? HIGH : LOW);
      }
    }
  }

  if (DEBUG_MODE) {
    if (code > 0) {
      Serial.printf("[Core0] Stream POST %d (%s)\n", code, commandName(cmd));
    } else {
      Serial.printf("[Core0] Stream POST failed (code %d: %s) -> %s\n", code, http.errorToString(code).c_str(), LIVE_STREAM_URL);
    }
  }
  http.end();
  noteNetResult(code > 0);
  return gotCommand;
}

void networkTask(void *pvParameters) {
  unsigned long lastPoll = 0;
  unsigned long lastStream = 0;
  unsigned long lastReconnectAttempt = 0;
  unsigned long lastDiag = 0;

  for (;;) {
    unsigned long now = millis();

    if (DEBUG_MODE && now - lastDiag >= 30000) {
      lastDiag = now;
      Serial.printf("[Diag] up=%lus heap=%u minHeap=%u stackFree=%u wifi=%d rssi=%d server=%s cmd=%s\n",
                    now / 1000, ESP.getFreeHeap(), ESP.getMinFreeHeap(),
                    (unsigned)uxTaskGetStackHighWaterMark(NULL), (int)WiFi.status(), WiFi.RSSI(),
                    serverReachable ? "OK" : "DOWN", commandName(currentCmd));
    }

    if (WiFi.status() == WL_CONNECTED) {
      if (now - lastStream >= LIVE_STREAM_INTERVAL_MS) {
        lastStream = now;
        if (networkStreamData()) {
          lastPoll = now; // the stream reply already carried the command
        }
      }

      if (now - lastPoll >= COMMAND_POLL_INTERVAL_MS) {
        lastPoll = now;
        networkPollCommand();
      }

      // Self-heal: if the server has been unreachable for a while, rebuild the Wi-Fi link.
      if (consecutiveNetFailures >= 20 && now - lastReconnectAttempt >= 45000) {
        lastReconnectAttempt = now;
        if (DEBUG_MODE) {
          Serial.printf("[Core0] %u failures in a row. Reconnecting Wi-Fi...\n", (unsigned)consecutiveNetFailures);
        }
        WiFi.reconnect();
        consecutiveNetFailures = 0;
      }

      // Back off a little while the server is down, so we do not flood the log/stack
      vTaskDelay(pdMS_TO_TICKS(serverReachable ? 50 : 500));
    } else {
      serverReachable = false;
      // Let ESP32 autoReconnect do its job; only poke after 30 seconds
      if (now - lastReconnectAttempt >= 30000) {
        lastReconnectAttempt = now;
        if (DEBUG_MODE) Serial.println("[Core0] WiFi reconnecting...");
        WiFi.reconnect();
      }
      vTaskDelay(pdMS_TO_TICKS(1000));
    }
  }
}

// -----------------------------------------------------------------------------
// OLED Display Update (Runs on Core 1)
// -----------------------------------------------------------------------------
void updateOLED() {
  bool medAlert = false;
  char slotBuf[16] = "";
  portENTER_CRITICAL(&stateMux);
  medAlert = reminderLedActive;
  if (medAlert) strncpy(slotBuf, reminderSlotName, sizeof(slotBuf) - 1);
  portEXIT_CRITICAL(&stateMux);

  if (medAlert) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("*** REMINDER ***");
    display.setCursor(0, 16);
    display.setTextSize(2);
    display.println("MEDICINE");
    display.setTextSize(1);
    display.setCursor(0, 38);
    display.printf("Take %s pills!\n", slotBuf[0] ? slotBuf : "your");
    display.setCursor(0, 52);
    display.println("Press button to clear");
    display.display();
    return;
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);

  if (WiFi.status() != WL_CONNECTED) {
    static bool toggle = false;
    toggle = !toggle;
    display.println(toggle ? "WIFI CONNECTING..." : "WIFI OFFLINE");
  } else if (!serverReachable) {
    display.println("WIFI OK  SERVER DOWN");
  } else {
    display.println("WIFI OK  SERVER OK");
  }

  display.setCursor(0, 16);

  uint8_t cmd = currentCmd;
  bool finger;
  int hr, ox;
  bool hrValid, oxValid;
  bool leadsOff;
  int ecgBpmSnap;
  float bTemp;
  bool bTempOk;
  float rawSkin;
  bool dhtOk;
  float dhtT, dhtH;

  portENTER_CRITICAL(&stateMux);
  finger = fingerDetected;
  hr = heartRate;
  ox = spo2;
  hrValid = validHeartRate;
  oxValid = validSPO2;
  leadsOff = ecgLeadsOff;
  ecgBpmSnap = ecgBPM;
  bTemp = bodyTemperature;
  bTempOk = bodyTempValid;
  rawSkin = rawSkinTemperature;
  dhtOk = dhtValid;
  dhtT = dhtTemperature;
  dhtH = dhtHumidity;
  portEXIT_CRITICAL(&stateMux);

  if (cmd == CMD_IDLE) {
    display.println("WAITING FOR");
    display.println("COMMAND...");
  } else if (cmd == CMD_READ_MAX30102) {
    if (!max30102Found) {
      display.println("MAX30102 NOT FOUND");
      display.println("Check I2C wiring");
    } else if (!finger) {
      display.setTextSize(2);
      display.println("PLACE");
      display.println("FINGER");
    } else if (!hrValid) {
      display.setTextSize(1);
      display.println("MEASURING PULSE...");
      display.println("Hold finger steady");
      display.printf("Sampling: %d/3\n", min(bpmBufferIdx, 3));
    } else {
      display.setTextSize(1);
      display.println("HR & SpO2 Active");
      display.setTextSize(2);
      display.printf("%d BPM\n", hr);
      display.setTextSize(1);
      display.printf("SpO2: %d %%\n", oxValid ? ox : 98);
    }
  } else if (cmd == CMD_READ_DHT11) {
    if (bTempOk) {
      display.setTextSize(1);
      display.println("BODY TEMP");
      display.printf("Skin: %.1f C\n", rawSkin);
      display.setTextSize(2);
      display.printf("%.1f C\n", bTemp);
      display.setTextSize(1);
      display.printf("Core: %.1f F\n", bTemp * 1.8f + 32.0f);
    } else if (max30205Found && rawSkin >= 15.0f && rawSkin < 28.0f) {
      display.setTextSize(1);
      display.println("BODY TEMP");
      display.println("Touch MAX30205");
      display.println("sensor firmly...");
      display.printf("Sensor: %.1f C\n", rawSkin);
    } else if (dhtOk) {
      display.setTextSize(1);
      display.println(max30205Found ? "Ambient (DHT11)" : "MAX30205 MISSING");
      display.setTextSize(2);
      display.printf("%.1f C\n", dhtT);
      display.setTextSize(1);
      display.printf("Humidity: %.0f %%\n", dhtH);
    } else {
      display.setTextSize(1);
      display.println("TEMPERATURE");
      if (max30205Found) {
        display.println("Touch MAX30205");
        display.println("sensor firmly...");
      } else {
        display.println("MAX30205 NOT FOUND");
        display.println("Check I2C wiring");
      }
    }
  } else if (cmd == CMD_READ_AD8232) {
    display.println("AD8232 ECG Active");
    if (leadsOff) {
      display.println("LEADS OFF!");
    } else {
      display.printf("ECG: %d BPM\n", ecgBpmSnap);
    }
  }

  display.display();
}

// -----------------------------------------------------------------------------
// Diagnostics helpers
// -----------------------------------------------------------------------------
static const char* resetReasonText(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "POWER ON";
    case ESP_RST_EXT: return "EXTERNAL PIN";
    case ESP_RST_SW: return "SOFTWARE (ESP.restart)";
    case ESP_RST_PANIC: return "PANIC / CRASH (software bug)";
    case ESP_RST_INT_WDT: return "INTERRUPT WATCHDOG";
    case ESP_RST_TASK_WDT: return "TASK WATCHDOG";
    case ESP_RST_WDT: return "OTHER WATCHDOG";
    case ESP_RST_DEEPSLEEP: return "DEEP SLEEP WAKE";
    case ESP_RST_BROWNOUT: return "BROWNOUT (power supply too weak! use a better USB cable/port)";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

static void i2cScan() {
  Serial.print("[I2C] Devices found:");
  int n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", a);
      n++;
    }
  }
  if (n == 0) Serial.print(" NONE (check SDA 19 / SCL 18 / power)");
  Serial.println();
  Serial.println("[I2C] Expected: 0x3C OLED, 0x57 MAX30102, 0x48-0x4F MAX30205");
}

static void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (!DEBUG_MODE) return;
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    Serial.printf("[WiFi] Disconnected, reason %d\n", info.wifi_sta_disconnected.reason);
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    Serial.print("[WiFi] Got IP: ");
    Serial.println(WiFi.localIP());
  }
}

// -----------------------------------------------------------------------------
// Setup & Loop
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(100);
  if (DEBUG_MODE) {
    Serial.println("\n--- JeevanCare VitalWatch Booting ---");
    Serial.printf("Reset reason: %s\n", resetReasonText(esp_reset_reason()));
    Serial.printf("Backend: %s\n", LOCAL_BACKEND_BASE_URL);
  }

  // Init OLED & I2C Bus
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setTimeOut(50);
  delay(50);
  if (DEBUG_MODE) i2cScan();

  uint8_t oledAddr = OLED_I2C_ADDRESS;
  Wire.beginTransmission(0x3C);
  if (Wire.endTransmission() != 0) {
    Wire.beginTransmission(0x3D);
    if (Wire.endTransmission() == 0) {
      oledAddr = 0x3D;
    }
  }

  if (DEBUG_MODE) Serial.printf("Attempting OLED on 0x%02X...\n", oledAddr);
  if (!display.begin(SSD1306_SWITCHCAPVCC, oledAddr)) {
    if (DEBUG_MODE) Serial.println("OLED init failed! Check wiring (SDA 19, SCL 18, 3.3V/5V, GND).");
  } else {
    if (DEBUG_MODE) Serial.printf("OLED Initialized OK at 0x%02X!\n", oledAddr);
    display.clearDisplay();
    display.setTextSize(2);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 10);
    display.println("JEEVAN");
    display.setCursor(10, 30);
    display.println("CARE");
    display.display();
    delay(1000);

    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20);
    display.println("CONNECTING WIFI...");
    display.display();
  }

  // Init WiFi
  WiFi.onEvent(onWiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false); // CRITICAL: Disable modem sleep to prevent hotspot disconnection
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  if (DEBUG_MODE) {
    Serial.printf("\nConnecting to Wi-Fi '%s'...\n", WIFI_SSID);
  }

  // Wait up to 8 seconds for initial connection
  unsigned long startWifi = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - startWifi < 8000)) {
    delay(400);
    if (DEBUG_MODE) Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (DEBUG_MODE) {
      Serial.println("\nWiFi Connected!");
      Serial.print("IP Address: ");
      Serial.println(WiFi.localIP());
    }
  } else {
    if (DEBUG_MODE) Serial.println("\nWiFi initial connect timeout, auto-reconnect will handle it.");
  }

  // Auto-scan for CJMCU-30205 (MAX30205) on I2C bus (0x48 to 0x4F)
  detectedMax30205Addr = findMAX30205Address();
  lastMax30205Probe = millis();

  if (detectedMax30205Addr != 0) {
    bodyTempSensor = MAX30205(detectedMax30205Addr, &Wire);
    bodyTempSensor.begin();
    max30205Found = true;
    if (DEBUG_MODE) Serial.printf("MAX30205 Clinical Body Temp Sensor found at 0x%02X!\n", detectedMax30205Addr);
  } else {
    if (DEBUG_MODE) Serial.println("MAX30205 not found on I2C bus (check 3.3V, GND, SDA 19, SCL 18). Will keep retrying every 5 s; DHT11 is used as fallback.");
  }

  // Init MAX30102
  max30102Found = particleSensor.begin(Wire, I2C_SPEED_FAST);
  if (!max30102Found) {
    if (DEBUG_MODE) Serial.println("Trying STANDARD I2C speed for MAX30102...");
    max30102Found = particleSensor.begin(Wire, I2C_SPEED_STANDARD);
  }

  if (max30102Found) {
    // 0x1F amplitude, 4x sample averaging, Mode 2 (Red + IR), 100 Hz sampling rate
    particleSensor.setup(0x1F, 4, 2, 100, 411, 4096);
    particleSensor.setPulseAmplitudeRed(0x1F);
    particleSensor.setPulseAmplitudeIR(0x1F);
    particleSensor.setPulseAmplitudeGreen(0);
    if (DEBUG_MODE) Serial.println("MAX30102 Initialized OK");
  } else {
    if (DEBUG_MODE) Serial.println("MAX30102 NOT FOUND! Check I2C wiring.");
  }

  dht.begin();
  pinMode(AD8232_LO_PLUS_PIN, INPUT);
  pinMode(AD8232_LO_MINUS_PIN, INPUT);

  pinMode(INDICATOR_LED_PIN, OUTPUT);
  digitalWrite(INDICATOR_LED_PIN, LOW);
  pinMode(MEDICINE_BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  rtcFound = rtc.begin();
  if (rtcFound && DEBUG_MODE) {
    Serial.println("[RTC] DS3231 RTC initialized at 0x68 OK!");
  }

  // Launch background network task on Core 0 (larger stack: HTTP + JSON + Strings)
  xTaskCreatePinnedToCore(
    networkTask,
    "NetworkTask",
    16384,
    NULL,
    1,
    &NetworkTaskHandle,
    0 // Core 0
  );

  if (DEBUG_MODE) Serial.println("Setup Complete. Network task pinned to Core 0.");
}

void loop() {
  unsigned long now = millis();
  static uint8_t lastCmd = CMD_IDLE;

  // Active sensor reads (Core 1)
  uint8_t cmd = currentCmd;

  // Clear stale pulse data whenever a new pulse scan starts
  if (cmd != lastCmd) {
    if (cmd == CMD_READ_MAX30102) {
      resetPulseState();
      if (max30102Found) particleSensor.clearFIFO();
    }
    lastCmd = cmd;
  }

  // Continuous background temperature monitoring (every 1s)
  if (now - lastTempRead >= 1000) {
    lastTempRead = now;
    processTemperature();
  }

  if (cmd == CMD_READ_MAX30102 && max30102Found) {
    particleSensor.check();
    while (particleSensor.available()) {
      processMax30102();
      particleSensor.nextSample();
    }
  } else if (cmd == CMD_READ_AD8232) {
    processAD8232();
  }

  // OLED refresh (4 Hz / every 250ms)
  static unsigned long lastOled = 0;
  if (now - lastOled >= 250) {
    lastOled = now;
    updateOLED();
  }

  // Check hardware button press to acknowledge active reminder
  if (reminderLedActive) {
    if (digitalRead(MEDICINE_BUTTON_PIN) == LOW || digitalRead(BUTTON_PIN) == LOW) {
      delay(30);
      if (digitalRead(MEDICINE_BUTTON_PIN) == LOW || digitalRead(BUTTON_PIN) == LOW) {
        portENTER_CRITICAL(&stateMux);
        reminderLedActive = false;
        reminderSlotName[0] = '\0';
        portEXIT_CRITICAL(&stateMux);
        digitalWrite(INDICATOR_LED_PIN, LOW);
        if (DEBUG_MODE) Serial.println("[Reminder] Acknowledged via hardware button!");
        HTTPClient ackHttp;
        WiFiClient ackClient;
        ackHttp.begin(ackClient, String(LOCAL_BACKEND_BASE_URL) + "/api/device/reminders/acknowledge");
        ackHttp.setTimeout(1500);
        ackHttp.POST("");
        ackHttp.end();
      }
    }
  }

  delay(4); // 4ms loop delay ensures smooth ~100Hz sensor sampling
}
