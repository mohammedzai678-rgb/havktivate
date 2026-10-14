/*
 * =============================================================================
 *  ULTRASONIC MODULE IDENTIFIER (SLOW SERIAL MONITOR)
 *  Use this sketch to physically identify Sensor 1, Sensor 2, and Sensor 3.
 * =============================================================================
 *
 *  PINS:
 *    SENSOR 1: TRIG = GPIO 5  | ECHO = GPIO 34 (via resistor divider)
 *    SENSOR 2: TRIG = GPIO 18 | ECHO = GPIO 35 (via resistor divider)
 *    SENSOR 3: TRIG = GPIO 19 | ECHO = GPIO 32 (via resistor divider)
 *
 *  HOW TO USE:
 *    1. Upload this code to your ESP32.
 *    2. Open Serial Monitor at 115200 baud.
 *    3. It updates slowly (every 1.5 seconds) so you can easily read it.
 *    4. Put your hand 10 cm in front of ONE sensor at a time.
 *       The screen will highlight: ">>> HAND DETECTED ON SENSOR X <<<"
 */

#include <Arduino.h>

struct SensorPinout {
  const char* label;
  uint8_t trigPin;
  uint8_t echoPin;
};

SensorPinout sensors[3] = {
  {"SENSOR 1 (Pins: TRIG 5  | ECHO 34)",  5, 34},
  {"SENSOR 2 (Pins: TRIG 18 | ECHO 35)", 18, 35},
  {"SENSOR 3 (Pins: TRIG 19 | ECHO 32)", 19, 32}
};

float measureDistanceCm(uint8_t trigPin, uint8_t echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(4);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  // 30ms timeout (max ~5 meters)
  unsigned long durationUs = pulseIn(echoPin, HIGH, 30000UL);
  if (durationUs == 0) {
    return -1.0f; // No echo received
  }
  return (durationUs * 0.0343f) / 2.0f;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("==================================================");
  Serial.println("    ULTRASONIC MODULE PHYSICAL IDENTIFIER         ");
  Serial.println("==================================================");
  Serial.println("Testing Sensors every 1.5 seconds...");
  Serial.println();

  for (int i = 0; i < 3; i++) {
    pinMode(sensors[i].trigPin, OUTPUT);
    digitalWrite(sensors[i].trigPin, LOW);
    pinMode(sensors[i].echoPin, INPUT);
  }
}

void loop() {
  float dist[3];

  // Measure each sensor with 50ms pause to avoid acoustic echo interference
  for (int i = 0; i < 3; i++) {
    dist[i] = measureDistanceCm(sensors[i].trigPin, sensors[i].echoPin);
    delay(50);
  }

  Serial.println("--------------------------------------------------");
  int closestSensor = -1;
  float closestDist = 9999.0f;

  for (int i = 0; i < 3; i++) {
    Serial.print("  ");
    Serial.print(sensors[i].label);
    Serial.print(" -> ");

    if (dist[i] < 0) {
      Serial.println("[ NO ECHO - Check wires or 5V ]");
    } else {
      Serial.print((int)dist[i]);
      Serial.println(" cm");

      // Check if someone placed their hand in front (< 30 cm)
      if (dist[i] > 2 && dist[i] < 30 && dist[i] < closestDist) {
        closestDist = dist[i];
        closestSensor = i + 1;
      }
    }
  }

  // Visual helper to immediately tell you where your hand is:
  if (closestSensor != -1) {
    Serial.println();
    Serial.print("  >>> HAND DETECTED ON SENSOR ");
    Serial.print(closestSensor);
    Serial.print(" (");
    Serial.print((int)closestDist);
    Serial.println(" cm) <<<");
  }

  Serial.println("--------------------------------------------------");
  Serial.println();

  // Slow down: wait 1.5 seconds before next print
  delay(1500);
}
