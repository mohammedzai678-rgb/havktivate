#ifndef JEEVANCARE_CONFIG_H
#define JEEVANCARE_CONFIG_H

// =============================================================================
// JEEVANCARE HARDWARE SPECIFICATION & PIN CONFIGURATION
// ESP32 DevKit / NodeMCU ESP32 CP2102
// =============================================================================

// --- Wi-Fi & Backend Endpoint Configuration ---
#define WIFI_SSID           "mohammed's M36"
#define WIFI_PASSWORD       "Zaid3232"
#define LOCAL_BACKEND_BASE_URL "http://10.236.84.35:8001"
#define BACKEND_INGEST_URL  LOCAL_BACKEND_BASE_URL "/api/device/ingest"
#define DEVICE_ID           "esp32_jeevancare_01"
#define DEVICE_API_KEY      "jeevan_esp32_prod_2026"

// Telemetry transmit interval (in milliseconds)
#define TELEMETRY_INTERVAL_MS 2000

// --- Authoritative JeevanCare Pin Map ---
// I2C Bus (Shared across OLED, MAX30102, MAX30205)
#define I2C_SCL_PIN         18 // GPIO 18 / D18 -> OLED SCL, MAX30102 SCL, MAX30205 SCL
#define I2C_SDA_PIN         19 // GPIO 19 / D19 -> OLED SDA, MAX30102 SDA, MAX30205 SDA

// Push Button (Debounced, Screen Mode Sequence)
#define BUTTON_PIN          27 // GPIO 27 / D27 -> Button (Uses INPUT_PULLUP, to GND)
#define MEDICINE_BUTTON_PIN 21 // GPIO 21 / D21 -> Medicine acknowledge button
#define INDICATOR_LED_PIN   22 // GPIO 22 / D22 -> Medicine indicator LED

// AD8232 Single-Lead ECG Front-End
#define AD8232_LO_PLUS_PIN  32 // GPIO 32 / D32 -> AD8232 LO+ (Lead-off detect)
#define AD8232_LO_MINUS_PIN 33 // GPIO 33 / D33 -> AD8232 LO- (Lead-off detect)
#define AD8232_OUTPUT_PIN   34 // GPIO 34 / D34 -> AD8232 OUTPUT (Analog ECG waveform)

// --- I2C Addresses ---
#define OLED_I2C_ADDRESS     0x3C
#define MAX30205_I2C_ADDRESS 0x4F
#define MAX30102_I2C_ADDRESS 0x57

// --- OLED Display Configuration ---
#define SCREEN_WIDTH         128
#define SCREEN_HEIGHT        64
#define OLED_RESET           -1

#define COMMAND_POLL_URL    LOCAL_BACKEND_BASE_URL "/api/device/command"
#define COMMAND_POLL_INTERVAL_MS 3000
#define LIVE_STREAM_URL     LOCAL_BACKEND_BASE_URL "/api/device/live-stream"
#define LIVE_STREAM_INTERVAL_MS 1000
#define DHT11_PIN           4
#define DEBUG_MODE          true

#endif // JEEVANCARE_CONFIG_H
