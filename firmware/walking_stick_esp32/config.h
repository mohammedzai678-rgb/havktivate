
#ifndef WALKING_STICK_CONFIG_H
#define WALKING_STICK_CONFIG_H

// =============================================================================
// JEEVANCARE WALKING STICK  (ESP32 #2)
// ESP32 DevKit / NodeMCU ESP32 CP2102  -  Arduino IDE board: "ESP32 Dev Module"
//
// ESP32 #1 (Jeevan Watch + medicine timer) keeps its own firmware:
//   firmware/jeevancare_esp32/jeevancare_esp32.ino
// This ESP32 #2 carries the 3 ultrasonic sensors + the LDR automatic light.
// =============================================================================

// --- Wi-Fi & Backend (same network / laptop server as the watch ESP32) ---
#define WIFI_SSID              "YOUR_WIFI_SSID"
#define WIFI_PASSWORD          "YOUR_WIFI_PASSWORD"
#define LOCAL_BACKEND_BASE_URL "http://YOUR_LAPTOP_IP:8001"   // laptop IPv4 (run `ipconfig`)
#define STICK_TELEMETRY_URL    LOCAL_BACKEND_BASE_URL "/api/stick/telemetry"
#define STICK_EVENT_URL        LOCAL_BACKEND_BASE_URL "/api/stick/event"
#define DEVICE_ID              "esp32_walking_stick_01"
#define DEVICE_API_KEY         "YOUR_DEVICE_API_KEY"
#define ENABLE_WIFI            true    // false = fully offline (LED + Serial still work)
#define TELEMETRY_INTERVAL_MS  1000

// --- Ultrasonic sensors (HC-SR04, powered from VIN / 5V) ---
// TRIG -> direct to the ESP32 pin.
// ECHO -> voltage divider: ECHO -> 1 kOhm -> [ESP32 pin] -> 2 kOhm -> GND
// Mount: Sensor 1 = LEFT, Sensor 2 = FRONT, Sensor 3 = RIGHT.
// (If you mount them differently, just swap the numbers below.)
#define LEFT_TRIG_PIN    5    // Sensor 1 TRIG
#define LEFT_ECHO_PIN    34   // Sensor 1 ECHO (input-only pin, via divider)
#define FRONT_TRIG_PIN   18   // Sensor 2 TRIG
#define FRONT_ECHO_PIN   35   // Sensor 2 ECHO (input-only pin, via divider)
#define RIGHT_TRIG_PIN   19   // Sensor 3 TRIG
#define RIGHT_ECHO_PIN   32   // Sensor 3 ECHO (via divider)

// --- LDR automatic light ---
// 3V3 -> LDR -> GPIO 33 -> 4.7 kOhm -> GND   (bright = high reading, dark = low)
// GPIO 2 -> 220 Ohm -> LED anode (long leg); LED cathode (short leg) -> GND
#define LDR_PIN                 33    // ADC1 channel
#define LIGHT_LED_PIN           2
#define LDR_DEFAULT_THRESHOLD   100   // darkness threshold matching user hardware (0..4095)
#define LDR_DEFAULT_HYSTERESIS  0     // 0 for instant zero-delay switching
#define LDR_CHECK_INTERVAL_MS   30    // check every 30ms for instant response
#define LDR_PRINT_INTERVAL_MS   500   // print interval

// --- Obstacle guidance tuning ---
#define OBSTACLE_WARN_CM        80    // obstacle closer than this is announced
#define OBSTACLE_NEAR_CM        35    // "Stop" level for the front sensor
#define CONTACT_CM              4     // closer than this = touching
#define CONTACT_HINT_CM         15    // echo lost right after being this close = touching
#define MAX_RANGE_CM            400
#define ECHO_TIMEOUT_US         45000UL  // > 38 ms so "nothing in range" pulses are seen
#define SENSOR_GAP_MS           30    // pause between sensors (prevents cross-talk)
#define GUIDANCE_STABLE_CYCLES  2     // same result twice before speaking
#define GUIDANCE_REPEAT_MS      5000  // repeat a persisting warning every 5 s
#define GUIDANCE_MIN_GAP_MS     1200  // minimum gap between two different messages
#define STICK_PRINT_INTERVAL_MS 500

#define SERIAL_BAUD             115200

#endif // WALKING_STICK_CONFIG_H
