/* ==================================================================== *
 *  $LABRAT front end
 *  One websocket feeds everything: sensors at 1Hz, token stats every
 *  ~20s, and launch rows as they come off pump.fun.
 * ==================================================================== */

const $ = (id) => document.getElementById(id);

const PROBE_BUF = 180; // 3 minutes at 1Hz
const probes = {
  temp: { buf: [], canvas: null, minSpan: 1.2, unit: "°C" },
  hum: { buf: [], canvas: null, minSpan: 3, unit: "%" },
};

const state = {
  config: null,
  stats: null,
  waves: new Map(), // clip id -> { buf, canvas, ctx, locked }
  lastSensorTick: 0,
  rows: new Map(), // mint -> { el, anim }
};

const SAMPLES_PER_TICK = 2; // must match server/sensors.js
const WAVE_BUF = 34;
// how long a row takes to climb to its confidence number (server/feed.js
// mirrors this so the auto-buyer only picks rows that have settled)
const ANALYSIS_MS = 10_000;

/* ----------------------------------------------------------- helpers --- */
const nf = new Intl.NumberFormat("en-US");

function fmtInt(n) {
  return n == null || !isFinite(n) ? "—" : nf.format(Math.round(n));
}

function fmtUsd(n) {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1000) return "$" + nf.format(Math.round(n));
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

function clock(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortAddr(a, head = 5, tail = 4) {
  return !a ? "" : a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1900);
}

/* ------------------------------------------------------------ config --- */
function applyConfig(c) {
  state.config = c;
  const tk = `$${c.tokenSymbol || "LABRAT"}`;

  $("logo-name").textContent = tk;
  $("logo-tag").textContent = c.tagline || "";
  $("powered-name").textContent = tk;
  $("cam-label").textContent = c.camLabel || "";
  $("about-title").textContent = c.aboutTitle || "";
  $("about-body").textContent = c.aboutBody || "";
  $("s-supply-sub").textContent = tk;
  document.title = `${tk} — ${c.tagline || "THE LAB TOKEN"}`;

  for (const id of ["buy-top", "buy-main"]) {
    const el = $(id);
    el.href = c.buyUrl;
    el.querySelector(".tk").textContent = tk;
    el.classList.toggle("disabled", !c.contractAddress);
    el.title = c.contractAddress ? "buy on pump.fun" : "contract address not set yet";
  }
  // the X link disappears rather than pointing nowhere when the field is blank
  const x = $("x-link");
  x.href = c.twitter || "#";
  x.style.display = c.twitter ? "" : "none";

  const chart = $("chart-main");
  chart.href = c.chartUrl;
  chart.classList.toggle("disabled", !c.contractAddress);

  const ca = $("ca-text");
  ca.textContent = c.contractAddress ? shortAddr(c.contractAddress, 6, 6) : "not set yet";
  ca.title = c.contractAddress || "";
  $("copy-ca").style.display = c.contractAddress ? "" : "none";

  // the looping clip
  const wrap = $("video-wrap");
  const vid = $("cam");
  if (c.videoUrl && vid.dataset.src !== c.videoUrl) {
    vid.dataset.src = c.videoUrl;
    vid.src = c.videoUrl;
    vid.play().catch(() => {});
  }
  if (!c.videoUrl) wrap.classList.add("empty");
}

/* ------------------------------------------------------------- stats --- */
function applyStats(s) {
  state.stats = s;

  $("s-supply").textContent = fmtInt(s.totalSupply);
  $("s-mc").textContent = fmtUsd(s.mcUsd);

  const chg = $("s-mc-chg");
  if (s.mcChangePct == null) {
    chg.textContent = s.mint ? "24h —" : "awaiting launch";
    chg.className = "stat-sub";
  } else {
    const up = s.mcChangePct >= 0;
    chg.textContent = `${up ? "+" : ""}${s.mcChangePct.toFixed(2)}%`;
    chg.className = `stat-sub ${up ? "up" : "down"}`;
  }

  $("s-holders").textContent = fmtInt(s.holders);
  const hs = $("s-holders-sub");
  hs.textContent = s.holdersToday != null && s.holdersToday !== 0 ? `${s.holdersToday > 0 ? "+" : ""}${fmtInt(s.holdersToday)} TODAY` : "";
  hs.className = `stat-sub ${s.holdersToday >= 0 ? "up" : "down"}`;

  $("s-liq").textContent = fmtUsd(s.liqUsd);
  $("s-liq-sub").textContent = s.liqNote || "";

  drawSpark(s.holdersSpark || []);

  // bonding curve → the phase bar
  const pct = Math.max(0, Math.min(100, s.progressPct || 0));
  $("phase-fill").style.width = `${pct}%`;
  $("phase-pct").textContent = `${pct.toFixed(pct >= 100 ? 0 : 1)}%`;
  const label = state.config?.phaseLabel || "";
  $("phase-text").textContent = s.graduated ? label.replace(/IN PROGRESS/i, "COMPLETE — GRADUATED") : label;
}

function drawSpark(points) {
  const c = $("spark");
  const ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 260;
  const h = c.clientHeight || 26;
  if (c.width !== w * dpr || c.height !== h * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) return;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const x = (i) => (i / (points.length - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / span) * (h - 7);

  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0]));
  for (let i = 1; i < points.length; i++) ctx.lineTo(x(i), y(points[i]));
  ctx.strokeStyle = "#b32d43";
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(179,45,67,.16)");
  g.addColorStop(1, "rgba(179,45,67,0)");
  ctx.fillStyle = g;
  ctx.fill();
}

/* ----------------------------------------------------------- sensors --- */
function buildSensorRows(clips) {
  const tbody = $("sensor-rows");
  if (tbody.childElementCount === clips.length) return;
  tbody.innerHTML = "";
  state.waves.clear();

  for (const c of clips) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="clip-cell"><span class="dot" data-dot></span>${c.id}</span></td>
      <td class="mv" data-mv>—</td>
      <td><canvas class="wave"></canvas></td>`;
    tbody.appendChild(tr);

    const canvas = tr.querySelector("canvas");
    state.waves.set(c.id, {
      buf: new Array(WAVE_BUF).fill(0),
      canvas,
      ctx: canvas.getContext("2d"),
      locked: true,
      row: tr,
    });
  }
}

function applySensors(p) {
  if (!p.clips?.length) return;
  buildSensorRows(p.clips);
  state.lastSensorTick = performance.now();
  $("sensor-clock").textContent = clock(p.ts);

  for (const c of p.clips) {
    const w = state.waves.get(c.id);
    if (!w) continue;
    const tr = w.row;
    tr.querySelector("[data-mv]").textContent = `${c.impulseMv >= 0 ? "+" : "-"}${Math.abs(c.impulseMv).toFixed(2).padStart(5, "0")} mV`;
    const dot = tr.querySelector("[data-dot]");
    dot.classList.toggle("off", !c.locked);
    tr.querySelectorAll("td").forEach((td) => td.classList.toggle("unlocked", !c.locked));
    w.locked = c.locked;
    w.buf.push(...c.wave);
    while (w.buf.length > WAVE_BUF) w.buf.shift();
  }

  // ---- the two enclosure probes, unrelated to the clips above ----
  const ch = p.chamber;
  if (ch) {
    $("p-temp").textContent = ch.tempC.toFixed(1);
    $("p-hum").textContent = ch.humidity.toFixed(1);
    pushProbe(probes.temp, ch.tempC);
    pushProbe(probes.hum, ch.humidity);
    drawProbe($("temp-spark"), probes.temp);
    drawProbe($("hum-spark"), probes.hum);
    $("p-temp-note").innerHTML = `${trendWord(probes.temp, "WARMING", "COOLING")} · CEILING <b>${ch.tempCap} °C</b>`;
    $("p-hum-note").innerHTML = `${trendWord(probes.hum, "RISING", "DRYING")} · FLOOR <b>${ch.humFloor} %</b>`;
  }

  // uptime, from the same payload
  const h = p.runtimeH || 0;
  const days = Math.floor(h / 24);
  const hrs = Math.floor(h % 24);
  const mins = Math.floor((h * 60) % 60);
  $("uptime").textContent = days > 0 ? `${days}d ${String(hrs).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m` : `${String(hrs).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`;
}

function pushProbe(probe, value) {
  probe.buf.push(value);
  while (probe.buf.length > PROBE_BUF) probe.buf.shift();
}

/** Which way the probe has moved over the last minute or so. */
function trendWord(probe, up, down) {
  const b = probe.buf;
  if (b.length < 30) return "CALIBRATING";
  const then = b[Math.max(0, b.length - 60)];
  const delta = b[b.length - 1] - then;
  const dead = probe.minSpan * 0.08; // ignore sensor noise
  return delta > dead ? up : delta < -dead ? down : "STEADY";
}

/** Probe trend line. Autoscaled, but never below minSpan — otherwise a probe
 *  sitting still would render its own noise as a mountain range. */
function drawProbe(canvas, probe) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 160;
  const h = canvas.clientHeight || 36;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const b = probe.buf;
  if (b.length < 2) return;

  let min = Math.min(...b);
  let max = Math.max(...b);
  const mid = (min + max) / 2;
  const span = Math.max(max - min, probe.minSpan);
  min = mid - span / 2;
  max = mid + span / 2;

  const x = (i) => (i / (b.length - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / (max - min)) * (h - 6);

  ctx.beginPath();
  ctx.moveTo(x(0), y(b[0]));
  for (let i = 1; i < b.length; i++) ctx.lineTo(x(i), y(b[i]));
  ctx.strokeStyle = "#b32d43";
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(179,45,67,.16)");
  g.addColorStop(1, "rgba(179,45,67,0)");
  ctx.fillStyle = g;
  ctx.fill();
}

/** Redraw every waveform, sliding the newest samples in from the right. */
function drawWaves() {
  const progress = Math.min(1, (performance.now() - state.lastSensorTick) / 1000);

  for (const w of state.waves.values()) {
    const { ctx, canvas, buf } = w;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth || 150;
    const ch = canvas.clientHeight || 30;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const visible = buf.length - SAMPLES_PER_TICK;
    const step = cw / (visible - 1);
    const mid = ch / 2;
    const amp = (ch / 2 - 2) * (w.locked ? 1 : 0.78);

    ctx.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = (i - SAMPLES_PER_TICK) * step + (1 - progress) * SAMPLES_PER_TICK * step;
      const y = mid - buf[i] * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = w.locked ? "#b32d43" : "#d29a9a";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  requestAnimationFrame(drawWaves);
}

/* -------------------------------------------------------------- feed --- */
const UP_SVG = `<svg class="f-check" viewBox="0 0 24 24"><path d="M12 5l7 8h-14z" fill="currentColor"/></svg>`;
const DOWN_SVG = `<svg class="f-check" viewBox="0 0 24 24"><path d="M12 19l-7-8h14z" fill="currentColor"/></svg>`;
const CHECK_SVG = `<svg class="f-check" viewBox="0 0 24 24"><path d="M4 12.5l5.5 5.5L20 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function feedRowEl(item) {
  const el = document.createElement("div");
  el.className = `feed-row${item.own ? " own" : ""}`;
  el.dataset.mint = item.mint;

  const avatar = item.image
    ? `<img class="f-avatar" src="${item.image}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'f-avatar',textContent:'${(item.symbol || "?")[0]}'}))">`
    : `<span class="f-avatar">${(item.symbol || "?")[0]}</span>`;

  el.innerHTML = `
    <div class="f-token">${avatar}<span class="f-symbol">$${item.symbol || "?"}</span></div>
    <div class="f-hash">${item.sig ? shortAddr(item.sig, 4, 4) : shortAddr(item.mint, 4, 4)}</div>
    <div class="f-verdict">ANALYZING…</div>
    <div class="f-conf"><span class="f-pct">0%</span><div class="f-bar"><i></i></div></div>
    <div class="f-time">${clock(item.ts)}</div>`;

  el.addEventListener("click", () => window.open(`https://pump.fun/coin/${item.mint}`, "_blank", "noopener"));
  return el;
}

/**
 * The confidence bar: climbs from zero, overshoots its number, and settles on
 * it inside five seconds. Damped oscillation — 1 - e^-4t·cos(8t) — which is
 * exactly zero at t=0 and lands on 1 by the time t hits 1.
 */
function animateConfidence(entry, target, duration = 5000, verdict = null) {
  if (entry.anim) cancelAnimationFrame(entry.anim);
  const el = entry.el;
  const bar = el.querySelector(".f-bar i");
  const pct = el.querySelector(".f-pct");
  const from = entry.value ?? 0;
  const t0 = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const shaped = duration >= 3000 ? 1 - Math.exp(-4 * t) * Math.cos(8 * t) : t;
    const raw = from + (target - from) * shaped;
    const v = Math.max(0, Math.min(100, raw));
    bar.style.width = `${v}%`;
    pct.textContent = `${Math.round(v)}%`;
    if (t < 1) {
      entry.anim = requestAnimationFrame(step);
    } else {
      entry.anim = null;
      entry.value = target;
      bar.style.width = `${target}%`;
      pct.textContent = `${Math.round(target)}%`;
      if (verdict) el.querySelector(".f-verdict").textContent = verdict;
    }
  };
  entry.anim = requestAnimationFrame(step);
}

function addFeedRow(item) {
  const rows = $("feed-rows");
  const el = feedRowEl(item);
  rows.prepend(el);

  const entry = { el, value: 0, anim: null };
  // one mint can appear twice (our own coin re-enters the feed); the map keeps
  // the newest row, which is the one an update should light up
  state.rows.set(item.mint, entry);

  if (item.sold) {
    markBought(item);
    markSoldRow(item);
  } else if (item.bought) {
    markBought(item);
  } else {
    animateConfidence(entry, item.confidence, ANALYSIS_MS, item.verdict);
  }

  while (rows.childElementCount > 14) {
    const gone = rows.lastElementChild;
    if (state.rows.get(gone.dataset.mint)?.el === gone) state.rows.delete(gone.dataset.mint);
    gone.remove();
  }
}

/** A buy and an exit are both events: the row rejoins the feed at the top with
 *  the time it happened, or it scrolls away before anyone sees it. */
function liftRow(el, ts) {
  const rows = $("feed-rows");
  if (rows.firstElementChild !== el) {
    rows.prepend(el);
    el.animate([{ transform: "translateY(-10px)", opacity: 0.35 }, { transform: "none", opacity: 1 }], {
      duration: 360,
      easing: "cubic-bezier(.2,.8,.3,1)",
    });
  }
  el.querySelector(".f-time").textContent = clock(ts);
}

/** The position closed — the row returns showing what it made or lost. */
function markSoldRow(item) {
  const entry = state.rows.get(item.mint);
  if (!entry) return;
  const el = entry.el;
  if (entry.anim) cancelAnimationFrame(entry.anim);
  entry.anim = null;

  const win = item.pnlPct >= 0;
  el.classList.remove("buying", "bought");
  el.classList.add("sold", win ? "win" : "loss");
  el.querySelector(".f-verdict").innerHTML = `${win ? UP_SVG : DOWN_SVG}${item.verdict}${item.dryRun ? " (DRY)" : ""}`;
  el.querySelector(".f-pct").textContent = `${win ? "+" : ""}${item.pnlPct.toFixed(0)}%`;
  el.querySelector(".f-bar i").style.width = `${Math.min(100, Math.abs(item.pnlPct))}%`;
  liftRow(el, item.ts);
}

function markBought(item) {
  const entry = state.rows.get(item.mint);
  if (!entry) return;
  const el = entry.el;
  el.classList.remove("buying");
  liftRow(el, item.ts);
  el.classList.add("bought");
  el.querySelector(".f-verdict").innerHTML = `${CHECK_SVG}BOUGHT${item.dryRun ? " (DRY)" : ""}`;
  animateConfidence(entry, 100, 1100);
  el.animate(
    [{ boxShadow: "inset 0 0 0 rgba(244,160,176,0)" }, { boxShadow: "inset 0 0 30px rgba(244,160,176,.35)" }, { boxShadow: "inset 0 0 0 rgba(244,160,176,0)" }],
    { duration: 1400, easing: "ease-out" },
  );
}

function updateFeedRow(item) {
  const entry = state.rows.get(item.mint);
  // a coin bought after its row was already trimmed off the bottom comes back
  // as a fresh gold row rather than being dropped silently
  if (!entry) return item.bought || item.sold ? addFeedRow(item) : undefined;
  if (item.sold) return markSoldRow(item);
  if (item.bought) return markBought(item);
  entry.el.classList.toggle("buying", Boolean(item.buying));
  if (item.buying) entry.el.querySelector(".f-verdict").textContent = "ACQUIRING SAMPLE…";
}

/** The scan line is the only place a dead launch feed can show itself — without
 *  it a stalled feed just looks like a frozen page. */
function setFeedStatus(connected) {
  const foot = document.querySelector(".feed-foot");
  $("scan-text").textContent = connected
    ? "SCANNING BLOCKCHAIN FOR NEW TOKENS..."
    : "LAUNCH FEED OFFLINE — RECONNECTING TO PUMP.FUN...";
  foot.classList.toggle("offline", !connected);
}

/* --------------------------------------------------------- websocket --- */
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  let scanning = $("scan-text");

  ws.onopen = () => {
    scanning.textContent = "SCANNING BLOCKCHAIN FOR NEW TOKENS...";
    document.querySelector(".feed-foot").classList.remove("offline");
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const { event, payload } = msg;
    if (event === "hello") {
      setFeedStatus(payload.feedConnected !== false);
      applyConfig(payload.config);
      applyStats(payload.stats);
      applySensors(payload.sensors);
      $("feed-rows").innerHTML = "";
      state.rows.clear();
      for (const item of [...payload.feed].reverse()) addFeedRow(item);
      // rows restored from history are already settled — no 5s climb
      for (const item of payload.feed) {
        const entry = state.rows.get(item.mint);
        if (!entry || item.bought) continue;
        if (entry.anim) cancelAnimationFrame(entry.anim);
        entry.anim = null;
        entry.value = item.confidence;
        entry.el.querySelector(".f-bar i").style.width = `${item.confidence}%`;
        entry.el.querySelector(".f-pct").textContent = `${item.confidence}%`;
        entry.el.querySelector(".f-verdict").textContent = item.verdict;
      }
    } else if (event === "config") {
      applyConfig(payload);
    } else if (event === "stats") {
      applyStats(payload);
    } else if (event === "sensors") {
      applySensors(payload);
    } else if (event === "feed:new") {
      addFeedRow(payload);
    } else if (event === "feed:update") {
      updateFeedRow(payload);
    } else if (event === "feed:status") {
      setFeedStatus(Boolean(payload.connected));
    }
  };

  ws.onclose = () => {
    scanning.textContent = "SIGNAL LOST — RECONNECTING...";
    document.querySelector(".feed-foot").classList.add("offline");
    setTimeout(connect, 2500);
  };
  ws.onerror = () => ws.close();
}

/* ------------------------------------------------------------ chrome --- */
function wireControls() {
  const vid = $("cam");
  const wrap = $("video-wrap");

  vid.addEventListener("error", () => wrap.classList.add("empty"));
  vid.addEventListener("loadeddata", () => wrap.classList.remove("empty"));

  $("play-btn").addEventListener("click", () => {
    const playing = !vid.paused;
    playing ? vid.pause() : vid.play().catch(() => {});
    $("ic-pause").hidden = playing;
    $("ic-play").hidden = !playing;
  });
  $("skip-btn").addEventListener("click", () => {
    vid.currentTime = 0;
    vid.play().catch(() => {});
  });

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen?.().catch(() => {});
  };
  $("fs-btn").addEventListener("click", fullscreen);
  $("fs-btn2").addEventListener("click", fullscreen);
  $("cam-x").addEventListener("click", () => $("cam-bar").classList.add("hidden"));

  $("copy-ca").addEventListener("click", async () => {
    const ca = state.config?.contractAddress;
    if (!ca) return;
    try {
      await navigator.clipboard.writeText(ca);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = ca;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    $("copy-ca").classList.add("done");
    setTimeout(() => $("copy-ca").classList.remove("done"), 1200);
    toast("CONTRACT ADDRESS COPIED");
  });

  // nav anchors: scroll and flash the target panel
  for (const a of document.querySelectorAll(".nav a")) {
    a.addEventListener("click", (e) => {
      const target = document.querySelector(a.getAttribute("href"));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.animate([{ borderColor: "#3fbe55" }, { borderColor: "" }], { duration: 1100, easing: "ease-out" });
    });
  }
}

wireControls();
connect();
requestAnimationFrame(drawWaves);
