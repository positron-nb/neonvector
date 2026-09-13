import { NETWORK } from '../config/settings.js';

// Maintains the WebSocket link to the ESP32 controller.
//
// Robustness features, all aimed at phone-hotspot / classroom Wi-Fi:
//  - connect timeout: an unreachable IP can hang a browser WebSocket for ~20s;
//    we abandon it after NETWORK.connectTimeoutMs and move on
//  - address rotation: primary URL, then mDNS name, then the ESP32 fallback
//    hotspot, so a changed DHCP address is found automatically
//  - silence watchdog: an "open" socket that stops delivering data (half-open
//    TCP after a Wi-Fi drop) is torn down and re-established
//  - fast capped backoff, and JSON validation so garbage never throws
export class WebSocketManager {
  constructor() {
    this.primaryUrl = NETWORK.defaultUrl;
    this.url = this.primaryUrl;
    this.ws = null;
    this.connected = false;
    this.manuallyClosed = true;

    this.onPacket = null;
    this.onStatusChange = null;
    this.onUrlConnected = null;

    this.latencyMs = null;
    this.lastMessageAt = 0;

    this._candidateIndex = 0;
    this._failures = 0;
    this._reconnectTimer = null;
    this._connectTimer = null;
    this._pingTimer = null;
    this._watchdogTimer = null;
    this._pendingPingId = null;
    this._pendingPingSentAt = 0;
  }

  _candidates() {
    return [...new Set([this.primaryUrl, ...NETWORK.fallbackUrls])];
  }

  connect(url) {
    if (url) this.primaryUrl = url;
    this.manuallyClosed = false;
    this._candidateIndex = 0;
    this._failures = 0;
    this._closeCurrent();
    this._openSocket();
  }

  _openSocket() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._connectTimer);
    if (this.manuallyClosed) return;

    const candidates = this._candidates();
    this.url = candidates[this._candidateIndex % candidates.length];

    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this._onAttemptFailed();
      return;
    }
    this.ws = socket;

    // mDNS (.local) lookups can take ~3 s on Windows the first time.
    const timeout = this.url.includes('.local') ? NETWORK.connectTimeoutMs * 2.4 : NETWORK.connectTimeoutMs;
    this._connectTimer = setTimeout(() => {
      if (this.ws === socket && socket.readyState !== WebSocket.OPEN) {
        this.ws = null;
        try { socket.close(); } catch (e) { /* ignore */ }
        this._onAttemptFailed();
      }
    }, timeout);

    socket.onopen = () => {
      if (this.ws !== socket) return;
      clearTimeout(this._connectTimer);
      this.connected = true;
      this._failures = 0;
      this.lastMessageAt = performance.now();
      this.primaryUrl = this.url;
      this._candidateIndex = 0;
      this._startTimers();
      this._notifyStatus();
      if (this.onUrlConnected) this.onUrlConnected(this.url);
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      this.lastMessageAt = performance.now();
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (!data || typeof data !== 'object') return;

      if (data.type === 'pong') {
        if (data.id === this._pendingPingId) {
          const rtt = performance.now() - this._pendingPingSentAt;
          this.latencyMs = this.latencyMs == null ? rtt : this.latencyMs * 0.7 + rtt * 0.3;
        }
        return;
      }
      if (this.onPacket) this.onPacket(data);
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      clearTimeout(this._connectTimer);
      const wasConnected = this.connected;
      this.connected = false;
      this._stopTimers();
      this._notifyStatus();
      if (wasConnected) {
        // A live link dropped: retry the same address first, quickly.
        this._candidateIndex = 0;
        this._scheduleReconnect(NETWORK.reconnectBaseDelayMs);
      } else {
        this._onAttemptFailed();
      }
    };

    socket.onerror = () => { /* onclose follows */ };
  }

  _onAttemptFailed() {
    if (this.manuallyClosed) return;
    this._failures++;
    this._candidateIndex++;
    // Fast retries for a blip; once the controller has clearly been absent
    // for a while, ease off (it's still found within ~5 s of powering up).
    const cap = this._failures > 12 ? 5000 : NETWORK.reconnectMaxDelayMs;
    const delay = Math.min(cap, NETWORK.reconnectBaseDelayMs * Math.pow(1.5, this._failures));
    this._scheduleReconnect(delay);
  }

  _scheduleReconnect(delay) {
    if (this.manuallyClosed) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._openSocket(), delay);
  }

  _startTimers() {
    this._stopTimers();
    this._pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this._pendingPingId = Math.random().toString(36).slice(2, 10);
      this._pendingPingSentAt = performance.now();
      try {
        this.ws.send(JSON.stringify({ type: 'ping', id: this._pendingPingId }));
      } catch (err) { /* socket closing */ }
    }, NETWORK.pingIntervalMs);

    this._watchdogTimer = setInterval(() => {
      if (!this.connected || !this.ws) return;
      if (performance.now() - this.lastMessageAt > NETWORK.silenceTimeoutMs) {
        const stale = this.ws;
        try { stale.close(); } catch (e) { /* ignore */ }
        // Some browsers delay onclose on a half-open socket; force the state change.
        if (this.ws === stale) stale.onclose();
      }
    }, 1000);
  }

  _stopTimers() {
    clearInterval(this._pingTimer);
    clearInterval(this._watchdogTimer);
    this._pingTimer = null;
    this._watchdogTimer = null;
  }

  _closeCurrent() {
    clearTimeout(this._connectTimer);
    clearTimeout(this._reconnectTimer);
    this._stopTimers();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try { old.close(); } catch (e) { /* ignore */ }
    }
    if (this.connected) {
      this.connected = false;
      this._notifyStatus();
    }
  }

  _notifyStatus() {
    if (this.onStatusChange) this.onStatusChange(this.connected);
  }

  disconnect() {
    this.manuallyClosed = true;
    this._closeCurrent();
  }
}
