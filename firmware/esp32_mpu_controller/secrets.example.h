// Copy this file to secrets.h (same folder) and fill in your details.
// secrets.h is git-ignored so your passwords never end up in the repo.
#pragma once

// The ESP32's own fallback hotspot.
const char* AP_SSID     = "NEON_VECTOR_CTRL";
const char* AP_PASSWORD = "change-me-8+chars";   // 8+ chars required

// Networks to join (2.4 GHz only). Add as many as you like.
const WifiNetwork NETWORKS[] = {
  { "YourNetwork",   "YourPassword" },
  { "SecondNetwork", "SecondPassword" },
};
