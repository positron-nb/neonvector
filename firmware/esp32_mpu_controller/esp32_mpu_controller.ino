/*
  NEON VECTOR — ESP32 + MPU6050 motion controller firmware
  ===========================================================
  Reads an MPU6050 (or register-compatible clone: MPU6500 / MPU6886 /
  MPU9250), fuses accel + gyro into roll/pitch with a complementary filter,
  and streams JSON to the browser game over a WebSocket at ~30 Hz.

  Link robustness (why this uses the async server):
    - The WebSocket server is fully non-blocking (ESP32Async). A slow or dead
      client can never stall the sensor loop or starve other clients.
    - "Latest frame wins": if a client still has unsent frames queued, the new
      frame is skipped instead of queued, so lag never builds up.
    - Wi-Fi auto-reconnects. If the configured network is unreachable, the
      ESP32 also opens its own fallback hotspot until the network returns.
    - mDNS name  neonvector.local  so a changed DHCP address is still found.
    - I2C bus auto-recovers if a jumper glitches.

  ------------------------------------------------------------------
  WIRING (default ESP32 DevKit I2C pins)
  ------------------------------------------------------------------
    MPU6050 VCC  -> ESP32 3V3
    MPU6050 GND  -> ESP32 GND
    MPU6050 SCL  -> ESP32 GPIO 22   (SCL_PIN below)
    MPU6050 SDA  -> ESP32 GPIO 21   (SDA_PIN below)
    XDA / XCL / AD0 / INT -> not connected

  ------------------------------------------------------------------
  ARDUINO LIBRARIES REQUIRED (Library Manager)
  ------------------------------------------------------------------
    1. "ESP Async WebServer"  by ESP32Async
    2. "Async TCP"            by ESP32Async
    3. "ArduinoJson"          by Benoit Blanchon (v7.x)
  Board package: "esp32" by Espressif, v3.x

  ------------------------------------------------------------------
  WIFI / NETWORK CONFIGURATION — EDIT BEFORE FLASHING
  ------------------------------------------------------------------
  USE_ACCESS_POINT true  -> ESP32 only hosts its own hotspot (AP_SSID);
                            game URL ws://192.168.4.1:81
  USE_ACCESS_POINT false -> ESP32 joins the strongest network in NETWORKS[];
                            game URL is printed on Serial, or use
                            ws://neonvector.local:81 (works on any of them)

  ------------------------------------------------------------------
  SERIAL COMMANDS (115200 baud)
  ------------------------------------------------------------------
    s -> rescan the I2C bus      r -> reset the orientation filter
    i -> print link/network status
*/

#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>

// ============================== CONFIG ====================================

#define USE_ACCESS_POINT false

// Wi-Fi credentials live in secrets.h (git-ignored). Copy secrets.example.h
// to secrets.h and fill in your networks. It defines AP_SSID, AP_PASSWORD and
// NETWORKS[] — known networks; the strongest in range is joined at boot and
// the next is tried if the current one is lost for SWITCH_NETWORK_AFTER_MS.
// Networks must be 2.4 GHz (the ESP32 has no 5 GHz radio).
struct WifiNetwork { const char* ssid; const char* pass; };
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing secrets.h - copy secrets.example.h to secrets.h and add your Wi-Fi networks."
#endif
const uint8_t NETWORK_COUNT = sizeof(NETWORKS) / sizeof(NETWORKS[0]);
const uint32_t SWITCH_NETWORK_AFTER_MS = 12000;

const char* MDNS_NAME = "neonvector";           // -> neonvector.local
const uint16_t WS_PORT = 81;

#define SDA_PIN 21
#define SCL_PIN 22
const uint32_t I2C_CLOCK_HZ = 100000;            // 100 kHz tolerates long jumper wires

const uint32_t SEND_INTERVAL_MS   = 33;          // ~30 Hz to the game
const uint32_t SAMPLE_INTERVAL_US = 4000;        // 250 Hz sensor/filter rate
// Own hotspot opens once every known network has had a turn and failed.
const uint32_t FALLBACK_AP_AFTER_MS = SWITCH_NETWORK_AFTER_MS * NETWORK_COUNT + 3000;
const uint16_t MAX_WS_CLIENTS = 3;               // oldest extra client is dropped

const float COMPLEMENTARY_ALPHA = 0.96f;

// ============================================================================

const uint8_t REG_PWR_MGMT_1   = 0x6B;
const uint8_t REG_CONFIG       = 0x1A;
const uint8_t REG_GYRO_CONFIG  = 0x1B;
const uint8_t REG_ACCEL_CONFIG = 0x1C;
const uint8_t REG_ACCEL_XOUT_H = 0x3B;
const uint8_t REG_WHO_AM_I     = 0x75;

const float ACCEL_LSB_PER_G  = 8192.0f;          // ±4 g
const float GYRO_LSB_PER_DPS = 65.5f;            // ±500 °/s
const float GRAVITY          = 9.80665f;

AsyncWebServer server(WS_PORT);
AsyncWebSocket ws("/");

struct ImuSample { float ax, ay, az, gx, gy, gz; };  // m/s^2, deg/s

uint8_t mpuAddr = 0;
bool mpuOk = false;
uint16_t readFailures = 0;
unsigned long lastSensorRetryMs = 0;

ImuSample latest = {0, 0, 9.8f, 0, 0, 0};
float rollEstimate = 0.0f;
float pitchEstimate = 0.0f;
float motionSmoothed = 0.0f;
bool filterSeeded = false;

unsigned long lastSampleUs = 0;
unsigned long lastSendMs = 0;
unsigned long lastCleanupMs = 0;

uint8_t currentNet = 0;
unsigned long lastJoinMs = 0;
volatile bool staGotIp = false;
volatile bool staLost = false;
unsigned long staDownSinceMs = 0;
bool fallbackApOn = false;
bool mdnsStarted = false;

uint32_t framesSent = 0;
uint32_t framesSkipped = 0;
uint32_t stalledDropped = 0;
uint32_t lowHeapSkips = 0;
const uint32_t MIN_FREE_HEAP = 40000;
const uint32_t MIN_ALLOC_BLOCK = 8000;

const char* resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "CRASH (panic/abort)";
    case ESP_RST_INT_WDT: return "CRASH (interrupt watchdog)";
    case ESP_RST_TASK_WDT: return "CRASH (task watchdog)";
    case ESP_RST_WDT: return "CRASH (watchdog)";
    case ESP_RST_BROWNOUT: return "BROWNOUT (weak USB power)";
    case ESP_RST_EXT: return "reset pin";
    default: return "other";
  }
}

// Connected client IDs, maintained from the async (network) task and read
// from loop(); guarded by a spinlock. Per-client bookkeeping lets one
// stalled consumer (e.g. a backgrounded browser tab that stopped reading)
// be skipped — and eventually dropped — without starving the active game.
const uint8_t MAX_TRACKED = 8;
const uint32_t STALL_DROP_MS = 8000;
struct TrackedClient { uint32_t id; uint32_t stalledSince; };
TrackedClient tracked[MAX_TRACKED];
uint8_t trackedCount = 0;
portMUX_TYPE trackedMux = portMUX_INITIALIZER_UNLOCKED;

void trackClient(uint32_t id) {
  portENTER_CRITICAL(&trackedMux);
  if (trackedCount < MAX_TRACKED) tracked[trackedCount++] = { id, 0 };
  portEXIT_CRITICAL(&trackedMux);
}

void untrackClient(uint32_t id) {
  portENTER_CRITICAL(&trackedMux);
  for (uint8_t i = 0; i < trackedCount; i++) {
    if (tracked[i].id == id) { tracked[i] = tracked[--trackedCount]; break; }
  }
  portEXIT_CRITICAL(&trackedMux);
}

// ------------------------------------------------------------------ I2C --

bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

int readReg(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  if (Wire.requestFrom(addr, (uint8_t)1) != 1) return -1;
  return Wire.read();
}

void startI2C() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);
  Wire.setTimeOut(20);
}

void scanI2C() {
  Serial.println("[I2C] Scanning bus...");
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("[I2C]   device at 0x%02X\n", addr);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("[I2C] NO devices found. Check VCC->3V3, GND->GND, SDA->GPIO21, SCL->GPIO22.");
  }
}

const char* chipName(int whoami) {
  switch (whoami) {
    case 0x68: return "MPU6050";
    case 0x70: return "MPU6500";
    case 0x71: return "MPU9250";
    case 0x73: return "MPU9255";
    case 0x19: return "MPU6886";
    case 0x98: return "MPU6050 clone";
    default:   return "unknown (treating as MPU6050-compatible)";
  }
}

bool initMPU(bool verbose) {
  mpuAddr = 0;
  for (uint8_t candidate : {(uint8_t)0x68, (uint8_t)0x69}) {
    Wire.beginTransmission(candidate);
    if (Wire.endTransmission() == 0) { mpuAddr = candidate; break; }
  }
  if (mpuAddr == 0) return false;

  int who = readReg(mpuAddr, REG_WHO_AM_I);
  if (verbose) Serial.printf("[MPU] Found 0x%02X, WHO_AM_I=0x%02X (%s)\n", mpuAddr, who & 0xFF, chipName(who));

  bool ok = writeReg(REG_PWR_MGMT_1, 0x80);      // reset
  delay(100);
  ok &= writeReg(REG_PWR_MGMT_1, 0x01);          // wake, PLL clock
  delay(10);
  ok &= writeReg(REG_CONFIG, 0x04);              // DLPF ~21 Hz
  ok &= writeReg(REG_GYRO_CONFIG, 0x08);         // ±500 °/s
  ok &= writeReg(REG_ACCEL_CONFIG, 0x08);        // ±4 g
  return ok;
}

bool readIMU(ImuSample& s) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddr, (uint8_t)14) != 14) return false;

  int16_t raw[7];
  for (int i = 0; i < 7; i++) raw[i] = (int16_t)((Wire.read() << 8) | Wire.read());

  s.ax = raw[0] / ACCEL_LSB_PER_G * GRAVITY;
  s.ay = raw[1] / ACCEL_LSB_PER_G * GRAVITY;
  s.az = raw[2] / ACCEL_LSB_PER_G * GRAVITY;
  s.gx = raw[4] / GYRO_LSB_PER_DPS;
  s.gy = raw[5] / GYRO_LSB_PER_DPS;
  s.gz = raw[6] / GYRO_LSB_PER_DPS;

  // An all-zero or saturated frame means the bus returned garbage.
  if (raw[0] == 0 && raw[1] == 0 && raw[2] == 0) return false;
  if (raw[0] == -1 && raw[1] == -1 && raw[2] == -1) return false;
  return true;
}

// ------------------------------------------------------------ WebSocket --

void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type,
               void* arg, uint8_t* data, size_t len) {
  if (type == WS_EVT_CONNECT) {
    client->setCloseClientOnQueueFull(false);  // we decide when to drop a slow client
    client->keepAlivePeriod(2);                // pings let dead peers time out
    // Disable Nagle: otherwise each small frame waits for the previous one's
    // ACK, and Windows delays ACKs up to 200 ms -> bursty, laggy delivery.
    if (client->client()) client->client()->setNoDelay(true);
    trackClient(client->id());
    Serial.printf("[WS] Client #%u connected from %s\n", client->id(), client->remoteIP().toString().c_str());
  } else if (type == WS_EVT_DISCONNECT) {
    untrackClient(client->id());
    Serial.printf("[WS] Client #%u disconnected\n", client->id());
  } else if (type == WS_EVT_DATA) {
    AwsFrameInfo* info = (AwsFrameInfo*)arg;
    if (!info->final || info->index != 0 || info->len != len || info->opcode != WS_TEXT) return;

    if (len > 128 || ESP.getMaxAllocHeap() < MIN_ALLOC_BLOCK) return;
    try {
      JsonDocument doc;
      if (deserializeJson(doc, data, len)) return;
      if (doc["type"] == "ping") {
        char out[64];
        snprintf(out, sizeof(out), "{\"type\":\"pong\",\"id\":\"%.16s\"}", doc["id"] | "");
        client->text(out);
      } else if (doc["type"] == "recalibrate") {
        filterSeeded = false;
      }
    } catch (const std::bad_alloc&) {
      lowHeapSkips++;
    }
  }
}

void sendFrame() {
  TrackedClient snapshot[MAX_TRACKED];
  portENTER_CRITICAL(&trackedMux);
  uint8_t n0 = trackedCount;
  memcpy(snapshot, tracked, sizeof(TrackedClient) * n0);
  portEXIT_CRITICAL(&trackedMux);
  if (n0 == 0) return;

  char buf[200];
  int n = snprintf(buf, sizeof(buf),
    "{\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f,"
    "\"roll\":%.1f,\"pitch\":%.1f,\"yaw\":0,\"motion\":%.2f,\"ok\":%d}",
    latest.ax, latest.ay, latest.az, latest.gx, latest.gy, latest.gz,
    rollEstimate, pitchEstimate, motionSmoothed, mpuOk ? 1 : 0);
  if (n <= 0 || n >= (int)sizeof(buf)) return;

  // Memory guard: connection churn (browser tabs reconnecting) makes the heap
  // swing. Skipping a frame is harmless; running out of memory inside the
  // WebSocket library aborts and reboots the board.
  if (ESP.getFreeHeap() < MIN_FREE_HEAP || ESP.getMaxAllocHeap() < MIN_ALLOC_BLOCK) {
    framesSkipped += n0;
    lowHeapSkips++;
    return;
  }

  // One shared buffer for every client (not a copy each).
  AsyncWebSocketSharedBuffer shared;
  try {
    shared = std::make_shared<std::vector<uint8_t>>((const uint8_t*)buf, (const uint8_t*)buf + n);
  } catch (const std::bad_alloc&) {
    framesSkipped += n0;
    lowHeapSkips++;
    return;
  }

  // A client's queue holds every frame until TCP-ACKed (not just unsent), so
  // build_opt.h sizes it for ~0.5 s in flight at 30 Hz — enough for a slow
  // phone hotspot. Only a genuinely congested client fills it: skip that one
  // this frame (latest frame wins) while everyone else still gets it. Each
  // ws.* call below takes the library's client-list lock, so it's safe
  // against async disconnects.
  uint32_t now = millis();
  for (uint8_t i = 0; i < n0; i++) {
    uint32_t id = snapshot[i].id;
    uint32_t stalled = 0;
    if (ws.availableForWrite(id)) {
      try {
        if (ws.text(id, shared)) framesSent++;
      } catch (const std::bad_alloc&) {
        // The library threw mid-queue; its locks are RAII and std::deque gives
        // the strong guarantee, so state is intact — just lose this frame.
        framesSkipped++;
        lowHeapSkips++;
      }
    } else {
      framesSkipped++;
      stalled = snapshot[i].stalledSince ? snapshot[i].stalledSince : now;
      if (now - stalled > STALL_DROP_MS) {
        Serial.printf("[WS] Client #%u stalled %lu ms — dropping it\n", id, (unsigned long)(now - stalled));
        ws.close(id);
        stalledDropped++;
        stalled = 0;
      }
    }
    portENTER_CRITICAL(&trackedMux);
    for (uint8_t k = 0; k < trackedCount; k++) {
      if (tracked[k].id == id) { tracked[k].stalledSince = stalled; break; }
    }
    portEXIT_CRITICAL(&trackedMux);
  }
}

// ----------------------------------------------------------------- WiFi --

void startFallbackAP() {
  if (fallbackApOn) return;
  WiFi.mode(USE_ACCESS_POINT ? WIFI_AP : WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  fallbackApOn = true;
  Serial.printf("[WiFi] Hotspot '%s' up (pw: %s). Game URL: ws://%s:%u\n",
                AP_SSID, AP_PASSWORD, WiFi.softAPIP().toString().c_str(), WS_PORT);
}

void stopFallbackAP() {
  if (!fallbackApOn || USE_ACCESS_POINT) return;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  fallbackApOn = false;
  Serial.println("[WiFi] Back on the main network — fallback hotspot off.");
}

void startMDNS() {
  if (mdnsStarted) MDNS.end();
  mdnsStarted = MDNS.begin(MDNS_NAME);
  if (mdnsStarted) {
    MDNS.addService("http", "tcp", WS_PORT);
    Serial.printf("[mDNS] Also reachable as ws://%s.local:%u\n", MDNS_NAME, WS_PORT);
  }
}

void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      staGotIp = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      staLost = true;
      break;
    default:
      break;
  }
}

// Scan once and return the index of the strongest known network in range
// (or the first one if none are visible right now).
uint8_t pickBestNetwork() {
  int found = WiFi.scanNetworks(false, false);
  int best = -1;
  int bestRssi = -1000;
  for (int i = 0; i < found; i++) {
    for (uint8_t k = 0; k < NETWORK_COUNT; k++) {
      if (WiFi.SSID(i) == NETWORKS[k].ssid && WiFi.RSSI(i) > bestRssi) {
        best = k;
        bestRssi = WiFi.RSSI(i);
      }
    }
  }
  WiFi.scanDelete();
  if (best >= 0) Serial.printf("[WiFi] Strongest known network: '%s' (%d dBm)\n", NETWORKS[best].ssid, bestRssi);
  else Serial.println("[WiFi] No known network visible yet — trying them in order.");
  return best >= 0 ? best : 0;
}

void joinNetwork(uint8_t index) {
  currentNet = index;
  lastJoinMs = millis();
  WiFi.disconnect(false, false);
  WiFi.begin(NETWORKS[currentNet].ssid, NETWORKS[currentNet].pass);
  Serial.printf("[WiFi] Joining '%s'...\n", NETWORKS[currentNet].ssid);
}

void setupWiFi() {
  WiFi.persistent(false);
  WiFi.setSleep(false);  // modem sleep causes 50-300 ms delivery stalls
  WiFi.onEvent(onWiFiEvent);

  if (USE_ACCESS_POINT) {
    startFallbackAP();
    startMDNS();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  staDownSinceMs = millis();
  joinNetwork(pickBestNetwork());
}

void serviceWiFi() {
  if (USE_ACCESS_POINT) return;

  if (staGotIp) {
    staGotIp = false;
    staDownSinceMs = 0;
    Serial.printf("[WiFi] Connected to '%s'  IP %s  RSSI %d dBm\n",
                  NETWORKS[currentNet].ssid, WiFi.localIP().toString().c_str(), WiFi.RSSI());
    Serial.printf("[WiFi] Game URL: ws://%s:%u\n", WiFi.localIP().toString().c_str(), WS_PORT);
    stopFallbackAP();
    startMDNS();
  }

  if (staLost) {
    staLost = false;
    if (staDownSinceMs == 0) {
      staDownSinceMs = millis();
      lastJoinMs = millis();
      Serial.printf("[WiFi] Lost '%s' — auto-reconnecting...\n", NETWORKS[currentNet].ssid);
    }
  }

  bool down = staDownSinceMs != 0 && WiFi.status() != WL_CONNECTED;

  // Still down on this network: move on to the next known one. With a
  // single network this simply re-joins it (auto-reconnect can stall).
  // Once our own hotspot is up, retry far less often: each join attempt can
  // retune the shared radio's channel and would kick laptops off the hotspot.
  uint32_t retryEvery = fallbackApOn ? 60000 : SWITCH_NETWORK_AFTER_MS;
  if (down && millis() - lastJoinMs > retryEvery) {
    joinNetwork((currentNet + 1) % NETWORK_COUNT);
  }

  // Every known network has had a turn: open our own hotspot as well, so the
  // controller is always reachable. STA keeps retrying in the background.
  if (down && !fallbackApOn && millis() - staDownSinceMs > FALLBACK_AP_AFTER_MS) {
    startFallbackAP();
    startMDNS();
  }
}

void printStatus() {
  Serial.printf("[STAT] sensor=%s  wifi=%s  ip=%s  rssi=%d  clients=%u  sent=%lu  skipped=%lu  heap=%u  minHeap=%u  maxAlloc=%u  lowHeapSkips=%lu\n",
                mpuOk ? "ok" : "FAULT",
                WiFi.status() == WL_CONNECTED ? "connected" : (fallbackApOn ? "hotspot" : "down"),
                WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : WiFi.softAPIP().toString().c_str(),
                WiFi.RSSI(), (unsigned)ws.count(), (unsigned long)framesSent, (unsigned long)framesSkipped,
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(), (unsigned)ESP.getMaxAllocHeap(),
                (unsigned long)lowHeapSkips);
}

// ---------------------------------------------------------------- setup --

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("=== NEON VECTOR controller firmware booting ===");
  Serial.printf("[SYS] Last reset: %s\n", resetReasonName(esp_reset_reason()));

  startI2C();
  scanI2C();
  mpuOk = initMPU(true);
  Serial.println(mpuOk ? "[MPU] Initialized OK." : "[MPU] ERROR: no sensor at 0x68/0x69 — retrying in background.");

  setupWiFi();

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);
  server.on("/health", [](AsyncWebServerRequest* req) {
    char body[360];
    snprintf(body, sizeof(body),
             "{\"sensor\":%s,\"clients\":%u,\"rssi\":%d,\"sent\":%lu,\"skipped\":%lu,\"stalledDropped\":%lu,"
             "\"lowHeapSkips\":%lu,\"uptimeS\":%lu,\"heap\":%u,\"minHeap\":%u,\"maxAlloc\":%u,\"lastReset\":\"%s\",\"ssid\":\"%s\"}",
             mpuOk ? "true" : "false", (unsigned)ws.count(), WiFi.RSSI(),
             (unsigned long)framesSent, (unsigned long)framesSkipped, (unsigned long)stalledDropped,
             (unsigned long)lowHeapSkips, (unsigned long)(millis() / 1000), (unsigned)ESP.getFreeHeap(),
             (unsigned)ESP.getMinFreeHeap(), (unsigned)ESP.getMaxAllocHeap(), resetReasonName(esp_reset_reason()),
             WiFi.status() == WL_CONNECTED ? NETWORKS[currentNet].ssid : (fallbackApOn ? AP_SSID : ""));
    req->send(200, "application/json", body);
  });
  server.begin();
  Serial.printf("[WS] Async WebSocket server on port %u (queue depth %d)\n", WS_PORT, (int)WS_MAX_QUEUED_MESSAGES);

  lastSampleUs = micros();
}

// ----------------------------------------------------------------- loop --

void handleSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 's') scanI2C();
    if (c == 'r') { filterSeeded = false; Serial.println("[MPU] Filter reset."); }
    if (c == 'i') printStatus();
  }
}

void serviceSensor() {
  if (!mpuOk) {
    if (millis() - lastSensorRetryMs > 500) {
      lastSensorRetryMs = millis();
      Wire.end();
      startI2C();
      mpuOk = initMPU(false);
      if (mpuOk) {
        Serial.println("[MPU] Sensor recovered.");
        filterSeeded = false;
        readFailures = 0;
      }
    }
    return;
  }

  unsigned long now = micros();
  if (now - lastSampleUs < SAMPLE_INTERVAL_US) return;
  float dt = (now - lastSampleUs) / 1000000.0f;
  lastSampleUs = now;
  if (dt > 0.1f) dt = 0.1f;

  ImuSample s;
  if (!readIMU(s)) {
    if (++readFailures >= 10) {
      Serial.println("[MPU] Repeated read failures — resetting I2C bus.");
      mpuOk = false;
      readFailures = 0;
    }
    return;
  }
  readFailures = 0;
  latest = s;

  float accelRoll  = atan2f(s.ay, s.az) * RAD_TO_DEG;
  float accelPitch = atan2f(-s.ax, sqrtf(s.ay * s.ay + s.az * s.az)) * RAD_TO_DEG;

  if (!filterSeeded) {
    rollEstimate = accelRoll;
    pitchEstimate = accelPitch;
    filterSeeded = true;
  }

  rollEstimate  = COMPLEMENTARY_ALPHA * (rollEstimate  + s.gx * dt) + (1.0f - COMPLEMENTARY_ALPHA) * accelRoll;
  pitchEstimate = COMPLEMENTARY_ALPHA * (pitchEstimate + s.gy * dt) + (1.0f - COMPLEMENTARY_ALPHA) * accelPitch;

  float accelMag = sqrtf(s.ax * s.ax + s.ay * s.ay + s.az * s.az);
  float jerk = fabsf(accelMag - GRAVITY);
  float k = 1.0f - expf(-dt / 0.04f);            // ~40 ms time constant, rate independent
  motionSmoothed += (jerk - motionSmoothed) * k;
}

void loop() {
  handleSerialCommands();
  serviceWiFi();
  serviceSensor();

  unsigned long nowMs = millis();
  if (mpuOk && nowMs - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = nowMs;
    sendFrame();
  }

  if (nowMs - lastCleanupMs > 1000) {
    lastCleanupMs = nowMs;
    ws.cleanupClients(MAX_WS_CLIENTS);
  }
}
