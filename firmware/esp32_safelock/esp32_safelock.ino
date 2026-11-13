// =====================================================================
// SafeLock — ESP32 firmware for the HTTP demo gateway
//
// Pairs with DEVICE_GATEWAY=http in apps/api/.env. The API reaches this
// board by its IP address (ESP32_URL) and authenticates every control
// request with a shared token (ESP32_TOKEN here = DEVICE_TOKEN below).
//
//   POST /lock     X-Device-Token  -> {"lockState","uptimeMs","bootId","doorOpen"}
//   POST /unlock   X-Device-Token  -> same
//   GET  /state    X-Device-Token  -> lock, RSSI, DHT22, door, vibration
//   GET  /                         -> read-only local status page
//   GET  /status, /sensor          -> read-only, used by that page
//
// The local page has no LOCK / UNLOCK buttons on purpose: an
// unauthenticated /unlock would let anyone on the Wi-Fi open the safe
// without the app's one-time code.
//
// Hardware (same wiring as the original SafeLocker sketch):
//   Relay ........ GPIO 23
//   DHT22 ........ GPIO 4
//   Reed switch .. GPIO 27 (to GND, internal pull-up; magnet = closed)
//   Vibration .... GPIO 26 (SW-420 style digital output)
//   OLED SSD1306 . SDA 21, SCL 22, address 0x3C (optional)
//
// Tamper detection happens on the SERVER, from what /state reports: a door
// reading OPEN, or any vibration, while the bolt is LOCKED. The OLED and the
// local page show the same thing locally so it can be seen at the safe.
//
// Secrets live in secrets.h (git-ignored). Copy secrets.example.h to
// secrets.h if it is missing.
//
// Libraries (Arduino Library Manager):
//   "DHT sensor library" + "Adafruit Unified Sensor"
//   "Adafruit SSD1306" + "Adafruit GFX Library"
// =====================================================================

#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <DHT.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD, DEVICE_TOKEN

// ---------------- RELAY ----------------
#define RELAY_PIN 23
// Change these if your relay is active LOW
#define RELAY_ON  HIGH   // energised = LOCKED (as in the original sketch)
#define RELAY_OFF LOW

bool isLocked = true;

// ---------------- DHT22 ----------------
#define DHT_PIN  4
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);

float temperature = NAN;
float humidity    = NAN;
unsigned long lastSensorRead = 0;
const unsigned long sensorInterval = 2000;

// ---------------- DOOR (reed switch) ----------------
// Set to 0 if no reed switch is fitted: /state then omits doorOpen and the
// server treats the door as closed (an unwired pull-up would read OPEN
// forever and every reading would look like a forced door).
#define HAS_DOOR_SENSOR 1
#define REED_PIN 27
// INPUT_PULLUP: magnet near = switch closed = LOW = door CLOSED.
bool doorOpen = false;

// ---------------- VIBRATION ----------------
#define HAS_VIBRATION_SENSOR 1
#define VIBRATION_PIN 26
// The level your module outputs while shaking. The original sketch used LOW;
// many SW-420 boards use HIGH. Flip this if "DETECTED" shows when still.
#define VIBRATION_ACTIVE LOW

// A knock lasts milliseconds and the server polls every few seconds, so a
// detection is LATCHED until the next /state reads (and clears) it.
bool vibrationLatched = false;
unsigned long lastVibrationMs = 0;
const unsigned long VIBRATION_DISPLAY_MS = 5000;   // "DETECTED" on page/OLED

// ---------------- OLED ----------------
#define OLED_SDA 21
#define OLED_SCL 22
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_ADDRESS 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
bool oledAvailable = false;
unsigned long lastOledDraw = 0;

// ---------------- MISC -----------------
const char* FIRMWARE_VERSION = "esp32-http-1.1";
char bootId[17];                 // random per boot, lets the server see restarts
unsigned long lastWifiCheck = 0;

WebServer server(80);

// =====================================================================
// HELPERS
// =====================================================================

bool authorised() {
  if (!server.hasHeader("X-Device-Token")) return false;
  String supplied = server.header("X-Device-Token");
  String expected = DEVICE_TOKEN;
  if (supplied.length() != expected.length()) return false;
  // Constant-time compare, so the token cannot be guessed a byte at a time.
  uint8_t diff = 0;
  for (size_t i = 0; i < expected.length(); i++) diff |= supplied[i] ^ expected[i];
  return diff == 0;
}

void rejectUnauthorised() {
  server.send(401, "application/json", "{\"error\":\"unauthorised\"}");
}

const char* lockStateText() {
  return isLocked ? "LOCKED" : "UNLOCKED";
}

bool vibrationRecent() {
  return lastVibrationMs != 0 && millis() - lastVibrationMs < VIBRATION_DISPLAY_MS;
}

// What the server will call tampering, shown locally too.
bool tamperNow() {
  if (!isLocked) return false;
  return (HAS_DOOR_SENSOR && doorOpen) || (HAS_VIBRATION_SENSOR && vibrationRecent());
}

String commandJson() {
  String json = "{\"lockState\":\"";
  json += lockStateText();
  json += "\",\"uptimeMs\":";
  json += String(millis());
  json += ",\"bootId\":\"";
  json += bootId;
  json += "\"";
#if HAS_DOOR_SENSOR
  json += ",\"doorOpen\":";
  json += doorOpen ? "true" : "false";
#endif
  json += "}";
  return json;
}

// =====================================================================
// OLED
// =====================================================================

void updateOLED() {
  if (!oledAvailable) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  if (tamperNow()) {
    // Inverted header so an alert is visible from across the room.
    display.fillRect(0, 0, 128, 12, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setTextSize(1);
    display.setCursor(4, 2);
    display.print(doorOpen ? "!! DOOR FORCED !!" : "!! TAMPER ALERT !!");
    display.setTextColor(SSD1306_WHITE);
  } else {
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("SMART SAFE SYSTEM");
    display.drawLine(0, 11, 128, 11, SSD1306_WHITE);
  }

  display.setCursor(0, 15);
  display.print("Lock: ");
  display.println(isLocked ? "LOCKED" : "UNLOCKED");

  display.print("Temp: ");
  if (!isnan(temperature)) { display.print(temperature, 1); display.println(" C"); }
  else display.println("ERROR");

  display.print("Humidity: ");
  if (!isnan(humidity)) { display.print(humidity, 1); display.println(" %"); }
  else display.println("ERROR");

#if HAS_DOOR_SENSOR
  display.print("Door: ");
  display.println(doorOpen ? "OPEN" : "CLOSED");
#endif
#if HAS_VIBRATION_SENSOR
  display.print("Vibration: ");
  display.println(vibrationRecent() ? "ALERT" : "NORMAL");
#endif

  display.display();
}

// =====================================================================
// SENSORS
// =====================================================================

// Called on every loop pass: door and vibration are cheap digital reads, and
// a knock is too short to catch on a 2-second timer.
void readFastSensors() {
#if HAS_DOOR_SENSOR
  bool open = digitalRead(REED_PIN) == HIGH;
  if (open != doorOpen) {
    doorOpen = open;
    Serial.println(open ? "Door OPENED" : "Door CLOSED");
    if (open && isLocked) Serial.println("!! Door open while LOCKED - possible forced entry");
    updateOLED();
  }
#endif

#if HAS_VIBRATION_SENSOR
  if (digitalRead(VIBRATION_PIN) == VIBRATION_ACTIVE) {
    if (!vibrationRecent()) {
      Serial.println(isLocked ? "!! Vibration while LOCKED - possible tampering" : "Vibration");
    }
    vibrationLatched = true;
    lastVibrationMs = millis();
  }
#endif
}

void readDht() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    temperature = t;
    humidity = h;
    Serial.printf("Temperature: %.1f C | Humidity: %.1f %% | Door: %s | Vibration: %s\n",
                  t, h, doorOpen ? "OPEN" : "CLOSED", vibrationRecent() ? "ALERT" : "NORMAL");
  } else {
    temperature = NAN;
    humidity = NAN;
    Serial.println("DHT22 reading failed!");
  }
}

// =====================================================================
// CONTROL (token required)
// =====================================================================

void handleLock() {
  if (!authorised()) return rejectUnauthorised();
  digitalWrite(RELAY_PIN, RELAY_ON);
  isLocked = true;
  Serial.println("LOCK command from server");
  updateOLED();
  server.send(200, "application/json", commandJson());
}

void handleUnlock() {
  if (!authorised()) return rejectUnauthorised();
  digitalWrite(RELAY_PIN, RELAY_OFF);
  isLocked = false;
  Serial.println("UNLOCK command from server");
  updateOLED();
  server.send(200, "application/json", commandJson());
}

void handleState() {
  if (!authorised()) return rejectUnauthorised();

  bool valid = !isnan(temperature) && !isnan(humidity);

  String json = "{\"lockState\":\"";
  json += lockStateText();
  json += "\",\"rssi\":";
  json += String(WiFi.RSSI());
  json += ",\"uptimeMs\":";
  json += String(millis());
  json += ",\"bootId\":\"";
  json += bootId;
  json += "\",\"firmware\":\"";
  json += FIRMWARE_VERSION;
  json += "\",\"sensorValid\":";
  json += valid ? "true" : "false";
  json += ",\"temperature\":";
  json += valid ? String(temperature, 1) : "null";
  json += ",\"humidity\":";
  json += valid ? String(humidity, 1) : "null";
#if HAS_DOOR_SENSOR
  json += ",\"doorOpen\":";
  json += doorOpen ? "true" : "false";
#endif
#if HAS_VIBRATION_SENSOR
  // Reported once, then cleared: "was there any vibration since you last asked".
  json += ",\"vibration\":";
  json += vibrationLatched ? "true" : "false";
  vibrationLatched = false;
#endif
  json += "}";

  server.send(200, "application/json", json);
}

// =====================================================================
// LOCAL READ-ONLY PAGE
// =====================================================================

void handleStatus() {
  server.send(200, "text/plain", isLocked ? "🔒 LOCKED" : "🔓 UNLOCKED");
}

void handleSensor() {
  bool valid = !isnan(temperature) && !isnan(humidity);
  String json = "{\"valid\":";
  json += valid ? "true" : "false";
  json += ",\"temperature\":";
  json += valid ? String(temperature, 1) : "0";
  json += ",\"humidity\":";
  json += valid ? String(humidity, 1) : "0";
  json += ",\"doorOpen\":";
  json += (HAS_DOOR_SENSOR && doorOpen) ? "true" : "false";
  json += ",\"vibration\":";
  json += (HAS_VIBRATION_SENSOR && vibrationRecent()) ? "true" : "false";
  json += ",\"tamper\":";
  json += tamperNow() ? "true" : "false";
  json += "}";
  server.send(200, "application/json", json);
}

const char PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SafeLocker</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;text-align:center;background:#ecfdf5;padding:20px 10px;margin:0}
.box{background:#fff;max-width:450px;margin:auto;padding:22px;border-radius:18px;box-shadow:0 4px 20px rgba(0,0,0,.12)}
.section{background:#f0fdf4;padding:15px;margin:14px 0;border-radius:12px}
#status{font-size:21px;font-weight:bold;margin:15px}
.value{font-size:27px;font-weight:bold;color:#15803d;margin:10px}
.normal{color:#15803d;font-weight:bold}.warning{color:#dc2626;font-weight:bold}.error{color:#c2410c;font-weight:bold}
.alert{background:#dc2626;color:#fff;padding:14px;border-radius:12px;font-weight:bold;font-size:18px}
.note{color:gray;font-size:12px}
</style></head><body><div class="box">
<h1>🔐 SafeLocker</h1>
<div class="section"><h2>Lock</h2><div id="status">Checking...</div>
<p class="note">Lock and unlock from the SafeLock app.<br>Unlocking needs a one-time code.</p></div>
<div class="section"><h2>🌡 Temperature</h2><div class="value" id="temperature">-- °C</div></div>
<div class="section"><h2>💧 Humidity</h2><div class="value" id="humidity">-- %</div></div>
<div class="section"><h2>🚪 Door</h2><div class="value" id="door">--</div></div>
<div class="section"><h2>⚠ Vibration</h2><div class="value" id="vibration">--</div></div>
<div id="warning">Waiting for sensor data...</div>
<p class="note">Updates every 2 seconds</p>
</div>
<script>
function updateStatus(){fetch('/status').then(r=>r.text()).then(t=>{status.innerHTML=t}).catch(()=>{status.innerHTML="Connection Error"})}
function updateSensor(){fetch('/sensor').then(r=>r.json()).then(d=>{
 const w=document.getElementById('warning');
 door.innerHTML=d.doorOpen?"OPEN":"CLOSED";
 vibration.innerHTML=d.vibration?"DETECTED":"NORMAL";
 if(d.valid){temperature.innerHTML=d.temperature.toFixed(1)+" °C";humidity.innerHTML=d.humidity.toFixed(1)+" %"}
 else{temperature.innerHTML="-- °C";humidity.innerHTML="-- %"}
 if(d.tamper){w.innerHTML=d.doorOpen?"🚨 DOOR FORCED OPEN WHILE LOCKED":"🚨 TAMPERING DETECTED WHILE LOCKED";w.className="alert"}
 else if(!d.valid){w.innerHTML="⚠ DHT22 reading unavailable";w.className="error"}
 else if(d.temperature>=45){w.innerHTML="⚠ HIGH TEMPERATURE!";w.className="warning"}
 else{w.innerHTML="✓ All Conditions Normal";w.className="normal"}
}).catch(()=>{document.getElementById('warning').innerHTML="⚠ Cannot connect to ESP32"})}
updateStatus();updateSensor();setInterval(updateSensor,2000);setInterval(updateStatus,2000);
</script></body></html>
)rawliteral";

void handleHome() {
  server.send_P(200, "text/html", PAGE);
}

// =====================================================================
// WIFI
// =====================================================================

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("WiFi Connected!");
  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.localIP());   // put this in ESP32_URL, e.g. http://192.168.43.120
}

// =====================================================================
// SETUP / LOOP
// =====================================================================

void setup() {
  Serial.begin(115200);

  // Boot LOCKED: a power cut must never leave the safe open.
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ON);
  isLocked = true;

  snprintf(bootId, sizeof(bootId), "%08lx%08lx",
           (unsigned long)esp_random(), (unsigned long)esp_random());

  dht.begin();
#if HAS_DOOR_SENSOR
  pinMode(REED_PIN, INPUT_PULLUP);
  doorOpen = digitalRead(REED_PIN) == HIGH;
#endif
#if HAS_VIBRATION_SENSOR
  pinMode(VIBRATION_PIN, INPUT);
#endif

  Wire.begin(OLED_SDA, OLED_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
    oledAvailable = true;
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 20);
    display.println("SMART SAFE SYSTEM");
    display.setCursor(10, 36);
    display.println("Connecting WiFi...");
    display.display();
    Serial.println("OLED initialized!");
  } else {
    Serial.println("OLED not found - continuing without it");
  }

  Serial.println("SafeLocker Starting...");
  connectWifi();

  // WebServer drops request headers unless asked to keep them.
  const char* headerKeys[] = {"X-Device-Token"};
  server.collectHeaders(headerKeys, 1);

  server.on("/", HTTP_GET, handleHome);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/sensor", HTTP_GET, handleSensor);
  server.on("/state", HTTP_GET, handleState);
  server.on("/lock", HTTP_POST, handleLock);
  server.on("/unlock", HTTP_POST, handleUnlock);
  server.onNotFound([]() { server.send(404, "text/plain", "Not found"); });

  server.begin();
  Serial.println("Web Server Started!");

  readDht();
  updateOLED();
}

void loop() {
  server.handleClient();
  readFastSensors();

  // Rejoin the hotspot if it dropped, without blocking the server for long.
  if (millis() - lastWifiCheck >= 10000) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi lost, reconnecting...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }

  if (millis() - lastSensorRead >= sensorInterval) {
    lastSensorRead = millis();
    readDht();
  }

  // Redraw twice a second so the vibration "ALERT" times out on screen.
  if (millis() - lastOledDraw >= 500) {
    lastOledDraw = millis();
    updateOLED();
  }
}
