/*
 * =============================================================================
 *  JEEVANCARE WALKING STICK  -  ESP32 #2
 *  3 x HC-SR04 obstacle guidance  +  LDR automatic light (external LED)
 *  Arduino IDE  ->  Board: "ESP32 Dev Module"  ->  Serial Monitor 115200 baud
 * =============================================================================
 *
 *  WIRING (see config.h for the pin numbers)
 *  -----------------------------------------
 *  LDR light sensor (4.7 kOhm kept separate from the LED resistor)
 *    LDR leg 1                -> 3V3
 *    LDR leg 2                -> GPIO 33
 *    4.7 kOhm leg 1           -> GPIO 33  (same point as LDR leg 2)
 *    4.7 kOhm leg 2           -> GND
 *
 *  External LED (220 Ohm kept separate from the LDR resistor)
 *    GPIO 2 -> 220 Ohm -> LED long leg (anode +)
 *    LED short leg (cathode -) -> GND
 *    !! Never drive a lamp / strip directly from GPIO 2 - use a relay / MOSFET module.
 *
 *  Ultrasonic sensors (HC-SR04)        Sensor 1   Sensor 2   Sensor 3
 *                                       (LEFT)    (FRONT)    (RIGHT)
 *    TRIG  (direct)                     GPIO 5    GPIO 18    GPIO 19
 *    ECHO  (via divider, mid-point)     GPIO 34   GPIO 35    GPIO 32
 *    VCC                                VIN/5V    VIN/5V     VIN/5V
 *    GND                                common GND
 *    Divider per sensor: ECHO -> 1 kOhm -> ESP32 pin -> 2 kOhm -> GND (5 V -> 3.3 V)
 *
 *  All GNDs (LDR divider, LED, 3 sensors, ESP32) go to one common GND rail.
 *
 *  BEHAVIOUR
 *  ---------
 *  - Dark  (LDR below threshold - hysteresis): LED ON,
 *      "The room is dark. Turning on the light. Please be cautious."
 *  - Bright (LDR above threshold + hysteresis): LED OFF,
 *      "Light has come back. Turning off the light."
 *  - Obstacles: "Obstacle on your right. Take left.", "Obstacle ahead. Take right." ...
 *  - Echo lost right after being very close: "You are touching something ..."
 *  Messages go to the Serial Monitor and (over Wi-Fi) to the laptop server,
 *  where the Voice Agent page speaks them through the headset.
 *
 *  SERIAL CALIBRATION COMMANDS (Serial Monitor, line ending "Newline")
 *    b        measure BRIGHT level (keep the LDR in normal room light)
 *    d        measure DARK level   (cover the LDR / switch the room light off)
 *             -> after both, threshold = midpoint, hysteresis = 10 % of span
 *    t 100    set threshold manually        h 20    set hysteresis manually
 *    s        show status                    r       reset to default (100)
 *    ?        help
 *  Calibrated values are stored in flash (survive reset / power-off).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "config.h"

// =============================================================================
// Types & shared state
// =============================================================================
enum EchoState : uint8_t { ECHO_OK, ECHO_CLEAR, ECHO_NONE };

struct UltraSensor {
  const char* name;
  uint8_t trigPin;
  uint8_t echoPin;
  float history[3];
  uint8_t histCount;
  uint8_t histIdx;
  float distanceCm;      // smoothed distance, -1 = nothing within range
  float lastValidCm;     // last real echo distance, -1 = none
  uint32_t lastValidMs;
  uint8_t noEchoStreak;
  bool contact;          // touching something
};

UltraSensor sensors[3] = {
  {"left",  LEFT_TRIG_PIN,  LEFT_ECHO_PIN},
  {"front", FRONT_TRIG_PIN, FRONT_ECHO_PIN},
  {"right", RIGHT_TRIG_PIN, RIGHT_ECHO_PIN},
};
UltraSensor& sLeft  = sensors[0];
UltraSensor& sFront = sensors[1];
UltraSensor& sRight = sensors[2];

struct Guidance {
  const char* code;
  const char* message;
  uint8_t priority;      // 1 = info, 2 = warning, 3 = urgent
};

const Guidance G_CLEAR              = {"clear",                 "Path is clear. You can walk straight.", 1};
const Guidance G_CONTACT_FRONT      = {"contact_front",         "You are touching something in front of you. Stop and step back.", 3};
const Guidance G_CONTACT_LEFT       = {"contact_left",          "You are touching something on your left. Move a little to the right.", 3};
const Guidance G_CONTACT_RIGHT      = {"contact_right",         "You are touching something on your right. Move a little to the left.", 3};
const Guidance G_BLOCKED_ALL        = {"blocked_all",           "Obstacles ahead and on both sides. Stop and turn back slowly.", 3};
const Guidance G_FRONT_NEAR_LEFT    = {"front_near_take_left",  "Stop. Obstacle very close ahead. Take left.", 3};
const Guidance G_FRONT_NEAR_RIGHT   = {"front_near_take_right", "Stop. Obstacle very close ahead. Take right.", 3};
const Guidance G_FRONT_TAKE_LEFT    = {"front_take_left",       "Obstacle ahead. Take left.", 2};
const Guidance G_FRONT_TAKE_RIGHT   = {"front_take_right",      "Obstacle ahead. Take right.", 2};
const Guidance G_NARROW             = {"narrow_path",           "Obstacles on both sides. Walk straight carefully.", 2};
const Guidance G_RIGHT_TAKE_LEFT    = {"right_take_left",       "Obstacle on your right. Take left.", 2};
const Guidance G_LEFT_TAKE_RIGHT    = {"left_take_right",       "Obstacle on your left. Take right.", 2};

const char* MSG_LIGHT_ON  = "The room is dark. Turning on the light. Please be cautious.";
const char* MSG_LIGHT_OFF = "Light has come back. Turning off the light.";

// Event sent to the laptop (queued -> sent by the network task on core 0)
struct StickEvent {
  char source[8];        // "stick" or "light"
  char code[28];
  char message[112];
  uint8_t priority;
  int16_t leftCm, frontCm, rightCm;
  uint16_t ldrAvg;
  bool lightOn;
};

// Latest snapshot for periodic telemetry
struct Telemetry {
  int16_t leftCm, frontCm, rightCm;
  bool leftContact, frontContact, rightContact;
  char guidance[28];
  uint16_t ldrRaw, ldrAvg, threshold, hysteresis;
  bool lightOn;
};

QueueHandle_t eventQueue = nullptr;
Telemetry telemetry = {};
portMUX_TYPE telemetryMux = portMUX_INITIALIZER_UNLOCKED;
Preferences prefs;

// LDR state
uint16_t ldrThreshold  = LDR_DEFAULT_THRESHOLD;
uint16_t ldrHysteresis = 0;
int calBright = -1;
int calDark   = -1;
bool lightOn = false;
uint16_t ldrRaw = 0;
uint16_t ldrAvg = 0;
uint32_t lastLdrReadMs = 0;
uint32_t lastLdrPrintMs = 0;

// Ultrasonic / guidance state
uint8_t nextSensor = 0;
uint32_t lastPingMs = 0;
uint32_t lastStickPrintMs = 0;
const Guidance* candidateG = nullptr;
uint8_t candidateCount = 0;
const Guidance* activeG = &G_CLEAR;
uint32_t lastAnnounceMs = 0;

// Serial command buffer
char cmdBuf[32];
uint8_t cmdLen = 0;
uint32_t lastCharMs = 0;

// =============================================================================
// Helpers
// =============================================================================
int16_t cmForReport(const UltraSensor& s) {
  if (s.contact) return 0;
  if (s.distanceCm < 0) return -1;
  return (int16_t)(s.distanceCm + 0.5f);
}

void queueEvent(const char* source, const char* code, const char* message, uint8_t priority) {
  if (!eventQueue) return;
  StickEvent ev = {};
  strlcpy(ev.source, source, sizeof(ev.source));
  strlcpy(ev.code, code, sizeof(ev.code));
  strlcpy(ev.message, message, sizeof(ev.message));
  ev.priority = priority;
  ev.leftCm = cmForReport(sLeft);
  ev.frontCm = cmForReport(sFront);
  ev.rightCm = cmForReport(sRight);
  ev.ldrAvg = ldrAvg;
  ev.lightOn = lightOn;
  if (xQueueSend(eventQueue, &ev, 0) != pdTRUE) {
    StickEvent dropped;                       // queue full: drop the oldest message
    xQueueReceive(eventQueue, &dropped, 0);
    xQueueSend(eventQueue, &ev, 0);
  }
}

void updateTelemetry() {
  portENTER_CRITICAL(&telemetryMux);
  telemetry.leftCm = cmForReport(sLeft);
  telemetry.frontCm = cmForReport(sFront);
  telemetry.rightCm = cmForReport(sRight);
  telemetry.leftContact = sLeft.contact;
  telemetry.frontContact = sFront.contact;
  telemetry.rightContact = sRight.contact;
  strlcpy(telemetry.guidance, activeG->code, sizeof(telemetry.guidance));
  telemetry.ldrRaw = ldrRaw;
  telemetry.ldrAvg = ldrAvg;
  telemetry.threshold = ldrThreshold;
  telemetry.hysteresis = ldrHysteresis;
  telemetry.lightOn = lightOn;
  portEXIT_CRITICAL(&telemetryMux);
}

// =============================================================================
// LDR automatic light (Instant switching - zero delay)
// =============================================================================
void setLight(bool on) {
  lightOn = on;
  digitalWrite(LIGHT_LED_PIN, on ? HIGH : LOW);
  if (on) {
    Serial.printf("LDR Reading: %u -> DARK - LIGHT ON. Agent: \"%s\"\n", ldrRaw, MSG_LIGHT_ON);
    queueEvent("light", "light_on", MSG_LIGHT_ON, 2);
  } else {
    Serial.printf("LDR Reading: %u -> BRIGHT - LIGHT OFF. Agent: \"%s\"\n", ldrRaw, MSG_LIGHT_OFF);
    queueEvent("light", "light_off", MSG_LIGHT_OFF, 1);
  }
  updateTelemetry();
}

void printLdrStatus() {
  Serial.printf("LDR Reading: %4u | Threshold: %u | %s\n",
                ldrRaw, ldrThreshold, lightOn ? "DARK - LIGHT ON" : "BRIGHT - LIGHT OFF");
}

void updateLight(uint32_t now) {
  if (now - lastLdrReadMs < LDR_CHECK_INTERVAL_MS) return;
  lastLdrReadMs = now;

  int lightValue = analogRead(LDR_PIN);
  ldrRaw = (uint16_t)lightValue;
  ldrAvg = (uint16_t)lightValue;

  bool isDark = (lightValue < (int)ldrThreshold);

  // Instant switching: as soon as low light is detected, glow immediately!
  if (isDark != lightOn) {
    setLight(isDark);
  }

  if (now - lastLdrPrintMs >= LDR_PRINT_INTERVAL_MS) {
    lastLdrPrintMs = now;
    printLdrStatus();
  }
}

void saveLdrSettings() {
  prefs.putUShort("thr", ldrThreshold);
}

uint16_t sampleLdrFor(uint32_t ms) {
  uint32_t start = millis();
  uint32_t sum = 0, count = 0;
  while (millis() - start < ms) {
    sum += analogRead(LDR_PIN);
    count++;
    delay(20);
  }
  return count ? (uint16_t)(sum / count) : analogRead(LDR_PIN);
}

void finishCalibration() {
  if (calBright < 0 || calDark < 0) {
    Serial.println(calBright < 0 ? "[CAL] Send 'b' with LDR in room light."
                                 : "[CAL] Send 'd' with LDR covered.");
    return;
  }
  int span = calBright - calDark;
  if (abs(span) < 20) {
    Serial.println("[CAL] Bright and dark readings are too close. Cover sensor properly when sending 'd'.");
    return;
  }
  ldrThreshold = (uint16_t)((calBright + calDark) / 2);
  saveLdrSettings();
  Serial.printf("[CAL] Saved new threshold = %u\n", ldrThreshold);
  printLdrStatus();
  setLight(analogRead(LDR_PIN) < ldrThreshold);
}

// =============================================================================
// Ultrasonic sensors
// =============================================================================
EchoState pingOnce(const UltraSensor& s, float& cmOut) {
  digitalWrite(s.trigPin, LOW);
  delayMicroseconds(4);
  digitalWrite(s.trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(s.trigPin, LOW);
  unsigned long us = pulseIn(s.echoPin, HIGH, ECHO_TIMEOUT_US);
  if (us == 0) return ECHO_NONE;                 // no echo pulse at all
  float cm = us * 0.0343f / 2.0f;
  if (cm > MAX_RANGE_CM) return ECHO_CLEAR;      // module reported "nothing in range"
  cmOut = cm;
  return ECHO_OK;
}

float medianOf(const float* v, uint8_t n) {
  if (n == 1) return v[0];
  if (n == 2) return (v[0] + v[1]) / 2.0f;
  float a = v[0], b = v[1], c = v[2];
  if ((a <= b && b <= c) || (c <= b && b <= a)) return b;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return a;
  return c;
}

void resetHistory(UltraSensor& s) {
  s.histCount = 0;
  s.histIdx = 0;
}

void updateSensor(UltraSensor& s, uint32_t now) {
  float cm = 0;
  EchoState st = pingOnce(s, cm);

  if (st == ECHO_OK) {
    s.noEchoStreak = 0;
    s.history[s.histIdx] = cm;
    s.histIdx = (s.histIdx + 1) % 3;
    if (s.histCount < 3) s.histCount++;
    s.distanceCm = medianOf(s.history, s.histCount);
    s.lastValidCm = s.distanceCm;
    s.lastValidMs = now;
    s.contact = (s.distanceCm <= CONTACT_CM);
  } else if (st == ECHO_CLEAR) {
    s.noEchoStreak = 0;
    resetHistory(s);
    s.distanceCm = -1;
    s.lastValidCm = -1;
    s.contact = false;
  } else {
    // No echo received (either open space > 4m or loose wire)
    // Only flag contact if an object was physically closer than 5 cm right before
    if (s.noEchoStreak < 255) s.noEchoStreak++;
    bool wasVeryClose = (s.lastValidCm >= 0 && s.lastValidCm <= CONTACT_CM && (now - s.lastValidMs < 800));
    if (wasVeryClose && s.noEchoStreak < 6) {
      s.contact = true;
      s.distanceCm = 0;
    } else {
      s.contact = false;
      s.distanceCm = -1;                         // clear path
      resetHistory(s);
    }
  }
}

bool isBlocked(const UltraSensor& s) {
  return s.contact || (s.distanceCm >= 0 && s.distanceCm <= OBSTACLE_WARN_CM);
}

float freeSpace(const UltraSensor& s) {
  if (s.contact) return 0;
  if (s.distanceCm < 0) return MAX_RANGE_CM + 1;
  return s.distanceCm;
}

const Guidance* decideGuidance() {
  if (sFront.contact) return &G_CONTACT_FRONT;
  if (sLeft.contact)  return &G_CONTACT_LEFT;
  if (sRight.contact) return &G_CONTACT_RIGHT;

  bool l = isBlocked(sLeft), f = isBlocked(sFront), r = isBlocked(sRight);
  if (f) {
    bool near = sFront.distanceCm <= OBSTACLE_NEAR_CM;
    if (l && r) return &G_BLOCKED_ALL;
    bool goLeft = r ? true : l ? false : (freeSpace(sLeft) >= freeSpace(sRight));
    if (goLeft) return near ? &G_FRONT_NEAR_LEFT : &G_FRONT_TAKE_LEFT;
    return near ? &G_FRONT_NEAR_RIGHT : &G_FRONT_TAKE_RIGHT;
  }
  if (l && r) return &G_NARROW;
  if (r) return &G_RIGHT_TAKE_LEFT;
  if (l) return &G_LEFT_TAKE_RIGHT;
  return &G_CLEAR;
}

void announce(const Guidance* g, uint32_t now) {
  lastAnnounceMs = now;
  Serial.printf("[STICK] Agent: \"%s\"  (L=%d F=%d R=%d cm)\n", g->message,
                cmForReport(sLeft), cmForReport(sFront), cmForReport(sRight));
  queueEvent("stick", g->code, g->message, g->priority);
}

void updateGuidance(uint32_t now) {
  const Guidance* g = decideGuidance();
  if (g == candidateG) {
    if (candidateCount < 255) candidateCount++;
  } else {
    candidateG = g;
    candidateCount = 1;
  }
  bool stable = candidateCount >= GUIDANCE_STABLE_CYCLES || g->priority >= 3;
  if (!stable) return;

  if (g != activeG) {
    if (g->priority < 3 && now - lastAnnounceMs < GUIDANCE_MIN_GAP_MS) return;  // retry next cycle
    activeG = g;
    announce(g, now);            // "Path is clear" only after an obstacle (activeG starts as clear)
  } else if (g != &G_CLEAR && now - lastAnnounceMs >= GUIDANCE_REPEAT_MS) {
    announce(g, now);            // obstacle still there: remind
  }
}

void printDistance(const char* label, const UltraSensor& s) {
  if (s.contact) Serial.printf("%s=CONTACT ", label);
  else if (s.distanceCm < 0) Serial.printf("%s=clear   ", label);
  else Serial.printf("%s=%3.0fcm   ", label, s.distanceCm);
}

void updateUltrasonic(uint32_t now) {
  if (now - lastPingMs < SENSOR_GAP_MS) return;
  updateSensor(sensors[nextSensor], now);
  lastPingMs = millis();
  nextSensor = (nextSensor + 1) % 3;
  if (nextSensor != 0) return;                   // full L/F/R cycle finished

  updateGuidance(now);
  updateTelemetry();
  if (now - lastStickPrintMs >= STICK_PRINT_INTERVAL_MS) {
    lastStickPrintMs = now;
    Serial.print("[STICK] ");
    printDistance("L", sLeft);
    printDistance("F", sFront);
    printDistance("R", sRight);
    Serial.printf("| %s\n", activeG->code);
  }
}

// =============================================================================
// Serial commands (calibration)
// =============================================================================
void printHelp() {
  Serial.println("Commands: t <n>=set threshold, s=status, r=reset to 100,");
  Serial.println("          b=calibrate bright, d=calibrate dark, ?=help");
}

void handleCommand(char* cmd) {
  while (*cmd == ' ') cmd++;
  if (!*cmd) return;
  char op = (char)tolower(cmd[0]);
  int value = atoi(cmd + 1);

  switch (op) {
    case 'b':
      Serial.println("[CAL] Measuring BRIGHT level for 2 s - keep LDR in room light...");
      calBright = sampleLdrFor(2000);
      Serial.printf("[CAL] bright = %d\n", calBright);
      finishCalibration();
      break;
    case 'd':
      Serial.println("[CAL] Measuring DARK level for 2 s - cover LDR...");
      calDark = sampleLdrFor(2000);
      Serial.printf("[CAL] dark = %d\n", calDark);
      finishCalibration();
      break;
    case 't':
      if (value > 0 && value < 4095) {
        ldrThreshold = (uint16_t)value;
        saveLdrSettings();
        Serial.printf("[CAL] Threshold set to %u (saved)\n", ldrThreshold);
        setLight(analogRead(LDR_PIN) < ldrThreshold);
      } else {
        Serial.println("[CAL] Use: t 100   (1..4094)");
      }
      break;
    case 'r':
      ldrThreshold = LDR_DEFAULT_THRESHOLD;
      calBright = calDark = -1;
      saveLdrSettings();
      Serial.printf("[CAL] Reset to default threshold %u (saved)\n", ldrThreshold);
      printLdrStatus();
      setLight(analogRead(LDR_PIN) < ldrThreshold);
      break;
    case 's':
      printLdrStatus();
      Serial.printf("[WIFI] %s\n", WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "not connected");
      break;
    default:
      printHelp();
  }
  updateTelemetry();
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    lastCharMs = millis();
    if (c == '\n' || c == '\r') {
      if (cmdLen) {
        cmdBuf[cmdLen] = '\0';
        handleCommand(cmdBuf);
        cmdLen = 0;
      }
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    }
  }
  // Also accept commands typed with "No line ending"
  if (cmdLen && millis() - lastCharMs > 300) {
    cmdBuf[cmdLen] = '\0';
    handleCommand(cmdBuf);
    cmdLen = 0;
  }
}

// =============================================================================
// Network task (core 0): Wi-Fi, events, telemetry. Never blocks the sensors.
// =============================================================================
bool postJson(const char* url, const char* body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setConnectTimeout(1200);
  http.setTimeout(1500);
  if (!http.begin(url)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST((uint8_t*)body, strlen(body));
  http.end();
  return code > 0 && code < 300;
}

void postEvent(const StickEvent& ev) {
  char body[480];
  snprintf(body, sizeof(body),
           "{\"device_id\":\"%s\",\"api_key\":\"%s\",\"source\":\"%s\",\"code\":\"%s\","
           "\"message\":\"%s\",\"priority\":%u,\"data\":{\"left_cm\":%d,\"front_cm\":%d,"
           "\"right_cm\":%d,\"ldr_avg\":%u,\"light_on\":%s}}",
           DEVICE_ID, DEVICE_API_KEY, ev.source, ev.code, ev.message, (unsigned)ev.priority,
           ev.leftCm, ev.frontCm, ev.rightCm, (unsigned)ev.ldrAvg, ev.lightOn ? "true" : "false");
  if (!postJson(STICK_EVENT_URL, body)) Serial.println("[WIFI] event not delivered (server unreachable)");
}

void postTelemetry() {
  Telemetry t;
  portENTER_CRITICAL(&telemetryMux);
  t = telemetry;
  portEXIT_CRITICAL(&telemetryMux);

  char body[600];
  snprintf(body, sizeof(body),
           "{\"device_id\":\"%s\",\"api_key\":\"%s\",\"data\":{"
           "\"left_cm\":%d,\"front_cm\":%d,\"right_cm\":%d,"
           "\"left_contact\":%s,\"front_contact\":%s,\"right_contact\":%s,"
           "\"guidance\":\"%s\",\"ldr_raw\":%u,\"ldr_avg\":%u,\"ldr_threshold\":%u,"
           "\"ldr_hysteresis\":%u,\"light_on\":%s,\"rssi\":%d,\"uptime_s\":%lu}}",
           DEVICE_ID, DEVICE_API_KEY, t.leftCm, t.frontCm, t.rightCm,
           t.leftContact ? "true" : "false", t.frontContact ? "true" : "false",
           t.rightContact ? "true" : "false", t.guidance, (unsigned)t.ldrRaw, (unsigned)t.ldrAvg,
           (unsigned)t.threshold, (unsigned)t.hysteresis, t.lightOn ? "true" : "false",
           (int)WiFi.RSSI(), (unsigned long)(millis() / 1000));
  postJson(STICK_TELEMETRY_URL, body);
}

void networkTask(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t lastAttempt = millis();
  uint32_t lastTelemetryMs = 0;
  bool wasConnected = false;

  for (;;) {
    bool connected = WiFi.status() == WL_CONNECTED;
    if (connected && !wasConnected) {
      Serial.printf("[WIFI] Connected to %s, IP %s -> server %s\n", WIFI_SSID,
                    WiFi.localIP().toString().c_str(), LOCAL_BACKEND_BASE_URL);
    } else if (!connected && wasConnected) {
      Serial.println("[WIFI] Connection lost - retrying (light + sensors keep working)");
    }
    wasConnected = connected;

    if (!connected && millis() - lastAttempt > 10000) {
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      lastAttempt = millis();
    }

    StickEvent ev;
    if (xQueueReceive(eventQueue, &ev, pdMS_TO_TICKS(50)) == pdTRUE && connected) {
      postEvent(ev);
    }
    if (connected && millis() - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
      lastTelemetryMs = millis();
      postTelemetry();
    }
  }
}

// =============================================================================
// Setup & loop
// =============================================================================
void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);
  Serial.println();
  Serial.println("=== JeevanCare Walking Stick (ESP32 #2): ultrasonic guidance + LDR light ===");
  Serial.println("LDR: 3V3-LDR-GPIO33-4.7k-GND | LED: GPIO2-220R-LED(+), LED(-)-GND");
  Serial.println("Ultrasonic TRIG 5/18/19, ECHO 34/35/32 (via divider), VCC 5V, common GND");

  for (UltraSensor& s : sensors) {
    pinMode(s.trigPin, OUTPUT);
    digitalWrite(s.trigPin, LOW);
    pinMode(s.echoPin, INPUT);
    s.distanceCm = -1;
    s.lastValidCm = -1;
  }

  pinMode(LIGHT_LED_PIN, OUTPUT);
  digitalWrite(LIGHT_LED_PIN, LOW);
  analogReadResolution(12);                       // 0..4095

  prefs.begin("stick", false);
  ldrThreshold = prefs.getUShort("thr", LDR_DEFAULT_THRESHOLD);
  if (ldrThreshold >= 1000) {
    ldrThreshold = 100;
    prefs.putUShort("thr", 100);
  }

  eventQueue = xQueueCreate(8, sizeof(StickEvent));
  if (ENABLE_WIFI) {
    xTaskCreatePinnedToCore(networkTask, "network", 8192, nullptr, 1, nullptr, 0);
  } else {
    Serial.println("[WIFI] Disabled in config.h - running offline");
  }

  // Initial light state: instant check exactly like test code
  int initialLight = analogRead(LDR_PIN);
  ldrRaw = (uint16_t)initialLight;
  ldrAvg = (uint16_t)initialLight;
  lightOn = (initialLight < (int)ldrThreshold);
  digitalWrite(LIGHT_LED_PIN, lightOn ? HIGH : LOW);
  printLdrStatus();
  printHelp();
  updateTelemetry();
}

void loop() {
  uint32_t now = millis();
  pollSerial();
  updateLight(now);
  updateUltrasonic(now);
  delay(2);
}
