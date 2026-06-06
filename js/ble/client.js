// Web Bluetooth client for the Cult Smart Scale.
//
// A weigh-in has TWO phases on the wire (see research/cult_scale_protocol.md):
//   1. weigh  — weight settles, then repeats (flag 0x01). We "lock" the weight.
//   2. body   — heart rate converges + impedance fills in (flag 0x00), then the
//               scale flashes the HR and powers off.
// So we must NOT finish on the weight lock — we wait for the body phase to
// complete (HR stabilises + impedance present), with a timeout and a
// power-off fallback so we always finalise.
//
// Events
//   'state'     'idle'|'connecting'|'connected'|'disconnected'
//   'live'      { weightKg, heartRate, phase, locked } — every clean frame
//   'locked'    { weightKg } — weight has settled; body-comp read begins
//   'measuring' { heartRate, hasImpedance, ticks } — body-phase progress
//   'complete'  { weightKg, heartRate, impedanceRaw, reason } — final reading (once)
//   'error'     Error

import { createEmitter } from '../util/events.js';
import { SCALE_SERVICE_UUID, MEASUREMENT_CHAR_UUID, NAME_PREFIXES } from './uuids.js';
import { parseCultFrame } from './parser.js';

const WEIGHT_LOCK_FRAMES = 3;      // identical weight frames → weight locked
const HR_LOCK_FRAMES     = 4;      // identical HR frames (body phase) → HR converged
const MEASURE_TIMEOUT_MS = 30000;  // after lock, force-complete if the scale lingers

export class CultScaleClient {
  #emitter = createEmitter();
  #device = null;
  #server = null;
  #char = null;
  #onDisconnect = null;

  // measurement state machine
  #lastWeight = null; #weightCount = 0; #weightLocked = false;
  #latestHR = null;   #latestImpedance = null;
  #lastHR = null;     #hrCount = 0;
  #completed = false; #timer = null;

  on(event, fn) { return this.#emitter.on(event, fn); }

  async requestAndConnect() {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      throw new Error('Web Bluetooth not available — use Chrome/Edge desktop or Bluefy on iPhone');
    }
    this.#reset();
    this.#emit('state', 'connecting');
    try {
      // Bluefy (WebKit) rejects 16-bit UUIDs given as integers ("request payload
      // unknown"), so we use full 128-bit UUID strings everywhere. Chrome accepts both.
      const nameFilters = NAME_PREFIXES.map((p) => ({ namePrefix: p }));
      this.#device = await navigator.bluetooth.requestDevice({
        filters: [...nameFilters, { services: [SCALE_SERVICE_UUID] }],
        optionalServices: [SCALE_SERVICE_UUID],
      });
      this.#onDisconnect = () => this.#handleDisconnect();
      this.#device.addEventListener('gattserverdisconnected', this.#onDisconnect);

      this.#server = await this.#device.gatt.connect();
      const service = await this.#server.getPrimaryService(SCALE_SERVICE_UUID);
      this.#char = await service.getCharacteristic(MEASUREMENT_CHAR_UUID);
      this.#char.addEventListener('characteristicvaluechanged', (e) => this.#handleFrame(e.target.value));
      await this.#char.startNotifications();

      this.#emit('state', 'connected');
    } catch (err) {
      this.#emit('state', 'idle');
      this.#emit('error', err);
      throw err;
    }
  }

  disconnect() {
    this.#clearTimer();
    if (this.#char) { this.#char.stopNotifications().catch(() => {}); this.#char = null; }
    if (this.#device) {
      if (this.#onDisconnect) {
        this.#device.removeEventListener('gattserverdisconnected', this.#onDisconnect);
        this.#onDisconnect = null;
      }
      if (this.#server?.connected) this.#server.disconnect();
      this.#device = null; this.#server = null;
    }
    this.#emit('state', 'disconnected');
  }

  // ── private ────────────────────────────────────────────────────────────────
  #emit(e, p) { this.#emitter.emit(e, p); }

  #handleFrame(dataView) {
    const f = parseCultFrame(dataView);
    if (!f || !f.checksumOk) return;
    const { phase, weightKg, heartRate, impedanceRaw } = f;

    this.#emit('live', { weightKg, heartRate, phase, locked: this.#weightLocked });

    // carry the latest body-phase HR / impedance (the locking frames may be weigh-phase)
    if (phase === 'body') {
      if (heartRate != null) this.#latestHR = heartRate;
      if (impedanceRaw != null) this.#latestImpedance = impedanceRaw;
    }

    // 1) lock the weight once it repeats
    if (weightKg > 0) {
      if (weightKg === this.#lastWeight) this.#weightCount++;
      else { this.#lastWeight = weightKg; this.#weightCount = 1; }
      if (!this.#weightLocked && this.#weightCount >= WEIGHT_LOCK_FRAMES) {
        this.#weightLocked = true;
        this.#emit('locked', { weightKg });
        // don't wait forever for HR — finalise after a timeout regardless
        this.#timer = setTimeout(() => this.#complete('timeout'), MEASURE_TIMEOUT_MS);
      }
    }

    // 2) after lock, wait for the heart-rate read to converge + impedance to land
    if (this.#weightLocked && phase === 'body' && heartRate != null) {
      if (heartRate === this.#lastHR) this.#hrCount++;
      else { this.#lastHR = heartRate; this.#hrCount = 1; }
      this.#emit('measuring', {
        heartRate, hasImpedance: this.#latestImpedance != null, ticks: this.#hrCount,
      });
      if (this.#hrCount >= HR_LOCK_FRAMES && this.#latestImpedance != null) {
        this.#complete('hr-stable');
      }
    }
  }

  #handleDisconnect() {
    // Scale powered off — the natural end of a weigh-in. Finalise with whatever
    // we captured if a weight was locked.
    if (this.#weightLocked && !this.#completed) this.#complete('disconnect');
    this.#emit('state', 'disconnected');
  }

  #complete(reason) {
    if (this.#completed || !this.#weightLocked) return;
    this.#completed = true;
    this.#clearTimer();
    this.#emit('complete', {
      weightKg: this.#lastWeight,
      heartRate: this.#latestHR,
      impedanceRaw: this.#latestImpedance,
      reason,
    });
  }

  #clearTimer() { if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; } }

  #reset() {
    this.#clearTimer();
    this.#lastWeight = null; this.#weightCount = 0; this.#weightLocked = false;
    this.#latestHR = null; this.#latestImpedance = null;
    this.#lastHR = null; this.#hrCount = 0; this.#completed = false;
  }
}
