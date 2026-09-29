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
  field: null,
  replaying: false,
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
  ctx.strokeStyle = "#57c98a";
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(87,201,138,.28)");
  g.addColorStop(1, "rgba(87,201,138,0)");
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
  ctx.strokeStyle = "#57c98a";
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(87,201,138,.28)");
  g.addColorStop(1, "rgba(87,201,138,0)");
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
    ctx.strokeStyle = w.locked ? "#7bf0a8" : "#3f7a58";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(87,201,138,.5)";
    ctx.shadowBlur = w.locked ? 4 : 0;
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

  if (!state.replaying) state.field?.spark();
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
  reactToBuy();
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

/** What the buyer actually did: one row per position, newest first. */
function renderBook(list) {
  const host = $("book-rows");
  if (!host || !Array.isArray(list)) return;

  const open = list.filter((x) => x.status === "open").length;
  const spent = list.reduce((s, x) => s + (x.solSpent || 0), 0);
  const sum = $("book-sum");
  if (sum) sum.innerHTML = list.length ? `<b>${open}</b> open · <b>${spent.toFixed(2)}</b> SOL` : "";

  if (!list.length) {
    host.innerHTML = '<div class="book-empty">nothing bought yet</div>';
    return;
  }

  host.innerHTML = list
    .map((x) => {
      const initial = (x.symbol || "?")[0];
      const avatar = x.image
        ? `<img class="f-avatar" src="${x.image}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : `<span class="f-avatar">${initial}</span>`;
      let cls = "open";
      let label = x.dryRun ? "PAPER" : "HOLDING";
      if (x.status === "closed") {
        cls = x.pnlPct >= 0 ? "win" : "loss";
        label = `${x.pnlPct >= 0 ? "+" : ""}${x.pnlPct.toFixed(0)}%`;
      } else if (x.status === "stuck") {
        cls = "stuck";
        label = "STUCK";
      }
      const t = new Date(x.at);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      return `<div class="book-row" data-mint="${x.mint}" data-sig="${x.sig || ""}">
        <div class="b-token">${avatar}<span class="b-symbol">${x.symbol || "?"}</span></div>
        <div class="b-sol">${(x.solSpent || 0).toFixed(3)}</div>
        <div class="b-state ${cls}">${label}</div>
        <div class="b-time">${hh}:${mm}</div>
      </div>`;
    })
    .join("");
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
      renderBook(payload.book);
      applyConfig(payload.config);
      applyStats(payload.stats);
      applySensors(payload.sensors);
      $("feed-rows").innerHTML = "";
      state.rows.clear();
      state.replaying = true;
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
      state.replaying = false;
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
    } else if (event === "book") {
      renderBook(payload);
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

  $("book-rows")?.addEventListener("click", (e) => {
    const row = e.target.closest(".book-row");
    if (!row) return;
    const sig = row.dataset.sig;
    const url = sig ? `https://solscan.io/tx/${sig}` : `https://pump.fun/coin/${row.dataset.mint}`;
    window.open(url, "_blank", "noopener");
  });

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
      target.animate([{ borderColor: "#57c98a" }, { borderColor: "" }], { duration: 1100, easing: "ease-out" });
    });
  }
}

/**
 * Fill the ambient. Sizes, lanes, drift and speed are all randomised so the rise
 * never reads as a loop, and every delay is NEGATIVE so the motes are already
 * mid-climb on the first paint rather than the page starting empty and filling.
 */
/**
 * The field.
 *
 * Neurons drift, link to whoever is near enough, and fire signals down those
 * links. Two things keep it cheap enough to run behind a live dashboard:
 * the glow is a sprite blitted per node rather than a gradient rebuilt every
 * frame, and node count scales with viewport area so a wide monitor is not
 * sparse and a phone is not soup.
 *
 * It is also wired to the real thing: every scanned token fires one signal,
 * and a buy fires a burst outward from the subject in the middle.
 */
function startNeuralField() {
  const canvas = $("neural");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: false });
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const LINK = 158;
  const nodes = [];
  const signals = [];
  let w = 0, h = 0, dpr = 1, last = performance.now();

  // one glow sprite, drawn once and then blitted — building a radial gradient
  // per node per frame is what makes fields like this drop frames
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 64;
  {
    const s = sprite.getContext("2d");
    const g = s.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.22, "rgba(150,255,190,.55)");
    g.addColorStop(0.55, "rgba(87,201,138,.18)");
    g.addColorStop(1, "rgba(87,201,138,0)");
    s.fillStyle = g;
    s.fillRect(0, 0, 64, 64);
  }

  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  function seed() {
    nodes.length = 0;
    const n = Math.round(Math.min(130, Math.max(40, (w * h) / 15500)));
    for (let i = 0; i < n; i++) {
      nodes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: rand(-0.16, 0.16),
        vy: rand(-0.16, 0.16),
        r: rand(1.1, 3.4),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  /** Fire one signal from a node to a neighbour. */
  function spark(from, gold) {
    if (signals.length > 70 || nodes.length < 2) return;
    const a0 = from ?? nodes[(Math.random() * nodes.length) | 0];
    let best = null, bestD = Infinity;
    for (let i = 0; i < 9; i++) {
      const c = nodes[(Math.random() * nodes.length) | 0];
      if (c === a0) continue;
      const d = Math.hypot(c.x - a0.x, c.y - a0.y);
      if (d < LINK && d < bestD) { best = c; bestD = d; }
    }
    if (!best) return;
    signals.push({ a: a0, b: best, t: 0, speed: rand(0.5, 1.15), gold: Boolean(gold) });
  }

  /** A buy landed: throw signals outward from the subject in the middle. */
  function burst(count) {
    const cx = w / 2, cy = h * 0.47;
    const near = nodes
      .map((n) => ({ n, d: Math.hypot(n.x - cx, n.y - cy) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, Math.max(6, count))
      .map((p) => p.n);
    for (const n of near) spark(n, true);
  }

  function frame(now) {
    const dt = Math.min(64, now - last);
    last = now;
    const t = now / 1000;

    ctx.fillStyle = "#050b07";
    ctx.fillRect(0, 0, w, h);

    for (const n of nodes) {
      n.x += n.vx * dt * 0.06;
      n.y += n.vy * dt * 0.06;
      if (n.x < -40) n.x = w + 40; else if (n.x > w + 40) n.x = -40;
      if (n.y < -40) n.y = h + 40; else if (n.y > h + 40) n.y = -40;
    }

    // links
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const q = nodes[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        const alpha = (1 - Math.sqrt(d2) / LINK) * 0.17;
        ctx.strokeStyle = "rgba(87,201,138," + alpha.toFixed(3) + ")";
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }

    // cell bodies
    ctx.globalCompositeOperation = "lighter";
    for (const n of nodes) {
      const twinkle = 0.62 + Math.sin(t * 1.1 + n.phase) * 0.38;
      const s = n.r * 11 * twinkle;
      ctx.globalAlpha = 0.5 * twinkle;
      ctx.drawImage(sprite, n.x - s, n.y - s, s * 2, s * 2);
    }

    // signals in flight
    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i];
      s.t += (s.speed * dt) / 1000;
      if (s.t >= 1) { signals.splice(i, 1); continue; }
      const x = s.a.x + (s.b.x - s.a.x) * s.t;
      const y = s.a.y + (s.b.y - s.a.y) * s.t;
      // a short tail, so it reads as travelling rather than blinking
      const tailT = Math.max(0, s.t - 0.16);
      const tx = s.a.x + (s.b.x - s.a.x) * tailT;
      const ty = s.a.y + (s.b.y - s.a.y) * tailT;
      ctx.globalAlpha = Math.sin(s.t * Math.PI) * 0.9;
      ctx.strokeStyle = s.gold ? "rgba(245,207,39,.85)" : "rgba(150,255,190,.8)";
      ctx.lineWidth = s.gold ? 2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
      const g = s.gold ? 20 : 13;
      ctx.globalAlpha = Math.sin(s.t * Math.PI) * (s.gold ? 0.95 : 0.7);
      ctx.drawImage(sprite, x - g, y - g, g * 2, g * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  if (reduced) {
    // one static frame, no loop
    ctx.fillStyle = "#050b07";
    ctx.fillRect(0, 0, w, h);
    for (const n of nodes) {
      const s = n.r * 9;
      ctx.globalAlpha = 0.4;
      ctx.drawImage(sprite, n.x - s, n.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
  } else {
    setInterval(() => spark(), 150);
    requestAnimationFrame(frame);
  }

  state.field = { spark, burst };
}

/** The subject flares and the field throws a burst when a buy lands. */
function reactToBuy() {
  if (state.replaying) return; // restored history is not news
  const wrap = $("brain-wrap");
  if (wrap) {
    wrap.classList.remove("fire");
    void wrap.offsetWidth; // restart the animation
    wrap.classList.add("fire");
  }
  state.field?.burst(14);
}

startNeuralField();
wireControls();
connect();
requestAnimationFrame(drawWaves);
