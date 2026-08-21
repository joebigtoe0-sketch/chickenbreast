import { cfg, saveConfig } from "./config.js";

/**
 * The six clips on the breast.
 *
 * Everything here is simulated, but simulated the way the real thing would
 * behave, and simulated ON THE SERVER so every visitor sees the same numbers:
 *
 *   temperature — the sample starts near room temp and warms under the lamps
 *                 toward a ceiling it never passes (exponential approach,
 *                 ~6h time constant). Once parked it still breathes on a slow
 *                 oscillation, because a flat line reads as broken.
 *   humidity    — the enclosure dries out as the surface loses moisture:
 *                 same curve, downward, with a floor.
 *   impulses    — an Ornstein-Uhlenbeck walk (mean-reverting noise) per clip
 *                 with occasional spikes. Never wanders off to infinity the
 *                 way a plain random walk does.
 *
 * A clip that loses lock (red dot) gets noisier and drifts further from its
 * mean until it re-locks, so the status light is driven by the data instead of
 * being decoration.
 */

const CLIPS = 6;
const TICK_MS = 1000;
const SAMPLES_PER_TICK = 4; // waveform points pushed to the client each tick

const TEMP_START = 22.2;
const TEMP_CAP = 26.4;
const TEMP_TAU_H = 6; // hours to ~63% of the way to the cap
const HUM_START = 46;
const HUM_FLOOR = 36.5;
const HUM_TAU_H = 8;

// fixed per-clip character: position on the breast changes what a clip reads
const TEMP_OFFSET = [-0.2, 0.1, -0.35, 0.05, -0.15, 0.3];
const HUM_OFFSET = [0.4, -0.6, 1.0, -0.2, -0.9, 0.5];
const MV_MEAN = [12.4, 8.6, 15.4, 9.9, 11.2, 16.1];

const rnd = () => Math.random();
// Box-Muller, clamped — one tail excursion shouldn't jump the display 3°C
const gauss = () => {
  const u = Math.max(1e-9, rnd());
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  return Math.max(-3, Math.min(3, n));
};

const clips = Array.from({ length: CLIPS }, (_, i) => ({
  id: i + 1,
  temp: TEMP_START + TEMP_OFFSET[i],
  hum: HUM_START + HUM_OFFSET[i],
  mv: MV_MEAN[i],
  locked: i < 3, // opening state matches the reference: three locked, three hunting
  phase: (i * Math.PI * 2) / CLIPS,
}));

let listeners = [];

function hoursRunning() {
  const start = cfg.experimentStart || Date.now();
  return Math.max(0, (Date.now() - start) / 3_600_000);
}

/** Where the whole rig is heading right now, before per-clip character. */
function targets() {
  const h = hoursRunning();
  const t = TEMP_START + (TEMP_CAP - TEMP_START) * (1 - Math.exp(-h / TEMP_TAU_H));
  const hum = HUM_START + (HUM_FLOOR - HUM_START) * (1 - Math.exp(-h / HUM_TAU_H));
  return { t, hum, h };
}

function tick() {
  const { t: tTarget, hum: humTarget, h } = targets();
  const slow = (phase, periodMin) => Math.sin((h * 60 * Math.PI * 2) / periodMin + phase);
  const out = [];

  for (const c of clips) {
    // lock/unlock — roughly once every couple of minutes per clip
    if (rnd() < (c.locked ? 0.004 : 0.012)) c.locked = !c.locked;
    const jitter = c.locked ? 1 : 2.4;

    const tAim = tTarget + TEMP_OFFSET[c.id - 1] + slow(c.phase, 42) * 0.22;
    c.temp += (tAim - c.temp) * 0.06 + gauss() * 0.012 * jitter;
    c.temp = Math.max(20.5, Math.min(TEMP_CAP + 0.6, c.temp));

    const hAim = humTarget + HUM_OFFSET[c.id - 1] + slow(c.phase + 1.7, 55) * 0.7;
    c.hum += (hAim - c.hum) * 0.05 + gauss() * 0.06 * jitter;
    c.hum = Math.max(HUM_FLOOR - 1.5, Math.min(HUM_START + 2.5, c.hum));

    // OU walk on the impulse reading, plus the odd spike
    const mvMean = MV_MEAN[c.id - 1];
    c.mv += (mvMean - c.mv) * (c.locked ? 0.12 : 0.05) + gauss() * 0.28 * jitter;
    if (rnd() < 0.02) c.mv += (rnd() < 0.5 ? -1 : 1) * (1.2 + rnd() * 2.4);
    c.mv = Math.max(0.4, Math.min(24, c.mv));

    // waveform micro-samples: normalised -1..1 around the clip's own level
    const wave = [];
    for (let s = 0; s < SAMPLES_PER_TICK; s++) {
      let v = gauss() * (c.locked ? 0.34 : 0.62);
      if (rnd() < 0.09) v += (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * (c.locked ? 0.6 : 1.1));
      wave.push(Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000);
    }

    out.push({
      id: c.id,
      tempC: Math.round(c.temp * 10) / 10,
      humidity: Math.round(c.hum),
      impulseMv: Math.round(c.mv * 100) / 100,
      locked: c.locked,
      wave,
    });
  }

  const payload = { ts: Date.now(), runtimeH: Math.round(h * 100) / 100, clips: out };
  for (const fn of listeners) {
    try {
      fn(payload);
    } catch {}
  }
  last = payload;
}

let last = { ts: Date.now(), runtimeH: 0, clips: [] };

/**
 * Start the experiment over: clock back to zero and the six clips back to their
 * opening readings.
 *
 * These are one action, not two. The drift curves are all anchored on
 * experimentStart, so moving the clock without re-seeding the clips would leave
 * them sitting at 26°C slowly sagging back toward 22°C over the next minute —
 * a fresh experiment that reads as a warm one. Snapping both is the honest
 * reset, and the tick at the end puts the new numbers on every screen at once.
 */
export function resetExperiment() {
  cfg.experimentStart = Date.now();
  saveConfig();
  clips.forEach((c, i) => {
    c.temp = TEMP_START + TEMP_OFFSET[i];
    c.hum = HUM_START + HUM_OFFSET[i];
    c.mv = MV_MEAN[i];
    c.locked = i < 3;
  });
  tick();
  return cfg.experimentStart;
}

export const getSensors = () => last;
export const onSensors = (fn) => listeners.push(fn);

export function startSensors() {
  // anchor the drift on first ever boot so it survives restarts
  if (!cfg.experimentStart) {
    cfg.experimentStart = Date.now();
    saveConfig();
  }
  // Seed each clip where the drift says it should already BE. The clips are
  // declared at their opening values, so without this a restart replays the
  // warm-up — a breast 30 hours into the experiment would climb from 22°C back
  // up to 26°C over the following minute, on every redeploy, in front of
  // whoever happens to be watching.
  const { t, hum } = targets();
  clips.forEach((c, i) => {
    c.temp = t + TEMP_OFFSET[i];
    c.hum = hum + HUM_OFFSET[i];
  });
  tick();
  setInterval(tick, TICK_MS);
}
