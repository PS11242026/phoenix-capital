/* Phoenix Capital client engine: weight-proportional heatmap with the 3-state day rule
   (green up / amber flat / red down vs last close), comparative-benchmark bars, track chart,
   hosted auto-refresh, and — with a feed key — live quotes + a live news wire in-browser.
   No dependencies. Colors #C0453B/#D97706/#0B7A5B validated for CVD; tiles always carry
   ticker + signed % + glyph so color is never the only channel. */
"use strict";

const $ = (s, el) => (el || document).querySelector(s);
const NEG = [192, 69, 59], MID = [232, 234, 237], POS = [11, 122, 91];
const FLAT = "#D97706", FLAT_EPS = 0.0005; // |1-day| < 0.05% = holding at the close

const fmtPct = (x, dp = 1, signed = true) =>
  x == null || isNaN(x) ? "–" : `${signed && x > 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`;
const fmtPx = (x, ccy) =>
  x == null ? "–" : (ccy === "INR" ? "₹" : "$") + x.toLocaleString(undefined, { maximumFractionDigits: 2 });

function lerp3(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function dayColor(dp, vmax) {
  if (dp == null || isNaN(dp)) return "rgb(178,186,196)";
  if (Math.abs(dp) < FLAT_EPS) return FLAT;
  const t = 0.34 + 0.66 * Math.min(1, Math.abs(dp) / vmax);   // floor keeps the sign legible
  return `rgb(${lerp3(MID, dp > 0 ? POS : NEG, t).join(",")})`;
}
function dayGlyph(dp) {
  if (dp == null || isNaN(dp)) return "";
  return Math.abs(dp) < FLAT_EPS ? "— " : dp > 0 ? "▲ " : "▼ ";
}
const lum = (c) => {
  const m = c.match(/[\da-f]{2}/gi);
  const rgb = c.startsWith("#") ? m.map(h => parseInt(h, 16)) : c.match(/\d+/g).map(Number);
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
};

/* ---------- squarified treemap (Bruls et al.) — tile area strictly ∝ weight ---------- */
function squarify(items, x, y, w, h) {
  const total = items.reduce((s, d) => s + d.value, 0);
  const scaled = items.map(d => ({ ...d, area: (d.value / total) * w * h }));
  const out = []; let row = [], rx = x, ry = y, rw = w, rh = h;
  const worst = (r, side) => {
    const s = r.reduce((a, d) => a + d.area, 0), mx = Math.max(...r.map(d => d.area)), mn = Math.min(...r.map(d => d.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layout = () => {
    const s = row.reduce((a, d) => a + d.area, 0), horiz = rw >= rh;
    const side = horiz ? s / rh : s / rw; let off = 0;
    for (const d of row) {
      const len = d.area / side;
      out.push(horiz ? { ...d, x: rx, y: ry + off, w: side, h: len } : { ...d, x: rx + off, y: ry, w: len, h: side });
      off += len;
    }
    if (horiz) { rx += side; rw -= side; } else { ry += side; rh -= side; }
    row = [];
  };
  for (const d of scaled) {
    const side = Math.min(rw, rh);
    if (!row.length || worst([...row, d], side) <= worst(row, side)) row.push(d);
    else { layout(); row.push(d); }
  }
  if (row.length) layout();
  return out;
}

/* ---------- heatmap ---------- */
function renderHeatmap(mountId, book) {
  const mount = $("#" + mountId);
  if (!mount) return;
  const st = book.status, W = 960, H = mount.dataset.h ? +mount.dataset.h : 340;
  const items = st.holdings.filter(r => r.weight).map(r => ({
    value: r.weight, tk: r.ticker, day: r.day_change, ret: r.return,
    px: r.price, entry: r.entry_price, w: r.weight, sector: r.sector,
    company: r.company,
  }));
  const vmax = Math.max(0.02, ...items.map(d => Math.abs(d.day ?? 0)));
  const tiles = squarify(items.sort((a, b) => b.value - a.value), 0, 0, W, H);
  let svg = `<svg class="hm" viewBox="0 0 ${W} ${H}" role="img" aria-label="Holdings heatmap: tile area = portfolio weight; green up, amber flat, red down vs last close">`;
  for (const t of tiles) {
    const fill = dayColor(t.day, vmax), dark = lum(fill) > 0.62;
    const tkFill = dark ? "#0F141B" : "#fff", pcFill = dark ? "rgba(15,20,27,.8)" : "rgba(255,255,255,.93)";
    const big = t.w > 105 && t.h > 68, med = t.w > 60 && t.h > 40;
    svg += `<g class="hm-g" data-tk="${t.tk}"><rect class="hm-tile" x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" fill="${fill}" rx="3"></rect>`;
    if (med) {
      const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
      svg += `<text class="hm-tk" x="${cx}" y="${cy - (big ? 12 : 3)}" text-anchor="middle" font-size="${big ? 17 : 12.5}" fill="${tkFill}">${t.tk}</text>`;
      svg += `<text class="hm-pct" x="${cx}" y="${cy + (big ? 8 : 13)}" text-anchor="middle" font-size="${big ? 12.5 : 10}" fill="${pcFill}">${dayGlyph(t.day)}${fmtPct(t.day, 2)}</text>`;
      if (big || (t.w > 78 && t.h > 56)) {
        svg += `<text class="hm-w" x="${cx}" y="${cy + (big ? 26 : 27)}" text-anchor="middle" font-size="10" fill="${pcFill}">${fmtPct(t.w, 1, false)} wt</text>`;
      }
    }
    svg += `</g>`;
  }
  svg += `</svg>`;
  mount.innerHTML = svg + `<div class="tip" role="status"></div>`;
  const tip = $(".tip", mount);
  mount.querySelectorAll(".hm-g").forEach(g => {
    const d = items.find(i => i.tk === g.dataset.tk);
    g.addEventListener("mousemove", ev => {
      const r = mount.getBoundingClientRect();
      const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
      tip.innerHTML = `<div class="t">${d.company ? esc(d.company) : d.tk}</div>` +
        `<div class="row"><span>${d.tk}</span><span>${esc((d.sector || "").replace(/_/g, " "))}</span></div>` +
        `<div class="row"><span>1-day</span><span style="color:${(d.day ?? 0) > FLAT_EPS ? "#5ad0a6" : Math.abs(d.day ?? 0) <= FLAT_EPS ? "#f2b25c" : "#f0958c"}">${dayGlyph(d.day)}${fmtPct(d.day, 2)}</span></div>` +
        `<div class="row"><span>weight</span><span>${fmtPct(d.w, 2, false)}</span></div>` +
        `<div class="row"><span>price</span><span>${fmtPx(d.px, st.currency)}</span></div>` +
        `<div class="row"><span>entry</span><span>${fmtPx(d.entry, st.currency)}</span></div>` +
        `<div class="row"><span>since entry</span><span>${fmtPct(d.ret, 1)}</span></div>`;
      tip.style.opacity = 1;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(ev.clientX - r.left + 14, 4), r.width - tw - 4) + "px";
      tip.style.top = Math.max(ev.clientY - r.top - tip.offsetHeight - 12, 4) + "px";
    });
    g.addEventListener("mouseleave", () => (tip.style.opacity = 0));
  });
}

/* ---------- comparative benchmark bars (book vs funds & indices) ---------- */
function renderCompare(mountId, book) {
  const mount = $("#" + mountId);
  if (!mount) return;
  const st = book.status;
  const rows = [{ name: (book.cfg?.label || "Portfolio") + " — this book", ret: st.return_since_inception, me: true }];
  for (const [bm, v] of Object.entries(st.benchmarks || {})) {
    const label = { SPY: "S&P 500 (SPY)", QQQ: "Nasdaq 100 (QQQ)", "^NSEI": "NIFTY 50" }[bm] || bm;
    rows.push({ name: label, ret: v.return });
  }
  for (const c of st.comparables || []) {
    rows.push({ name: c.name.replace(" (modeled)", ""), ret: c.return, model: c.kind === "run_rate" });
  }
  const data = rows.filter(r => r.ret != null).sort((a, b) => b.ret - a.ret);
  const W = 960, rowH = 34, M = { t: 8, r: 86, b: 8, l: 250 };
  const H = M.t + M.b + data.length * rowH;
  const lo = Math.min(0, ...data.map(d => d.ret)), hi = Math.max(0, ...data.map(d => d.ret));
  const span = (hi - lo) || 1;
  const X = v => M.l + ((v - lo) / span) * (W - M.l - M.r);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Since-inception return: portfolio versus comparable funds and indices">`;
  s += `<line x1="${X(0)}" x2="${X(0)}" y1="${M.t}" y2="${H - M.b}" stroke="#C4CBD4" stroke-width="1.2"></line>`;
  data.forEach((d, i) => {
    const y = M.t + i * rowH, bh = 16, by = y + (rowH - bh) / 2;
    const x0 = Math.min(X(0), X(d.ret)), bw = Math.max(1.5, Math.abs(X(d.ret) - X(0)));
    const fill = d.me ? "#0B7A5B" : d.ret >= 0 ? "#9DBFB3" : "#D9A39D";
    s += `<text x="${M.l - 12}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="${d.me ? 12.5 : 12}" font-weight="${d.me ? 700 : 450}" fill="${d.me ? "#0F141B" : "#5B6675"}" font-family="inherit">${d.name}${d.model ? " *" : ""}</text>`;
    s += `<rect x="${x0}" y="${by}" width="${bw}" height="${bh}" rx="3" fill="${fill}"${d.me ? ' stroke="#C9A227" stroke-width="1.5"' : ""}></rect>`;
    s += `<text x="${X(d.ret) + (d.ret >= 0 ? 8 : -8)}" y="${y + rowH / 2 + 4}" text-anchor="${d.ret >= 0 ? "start" : "end"}" font-size="11.5" font-weight="${d.me ? 700 : 550}" fill="${d.ret >= 0 ? "#0B7A5B" : "#C0453B"}" font-family="ui-monospace,Consolas,monospace">${fmtPct(d.ret, 1)}</text>`;
  });
  mount.innerHTML = s + `</svg>`;
}

/* ---------- track chart (cumulative % since inception) ---------- */
function renderTrack(mountId, book) {
  const mount = $("#" + mountId);
  if (!mount) return;
  const tr = book.track, id = book.status.book_id;
  const rows = (tr.rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) { mount.innerHTML = `<p class="lede">Track record accrues from inception (${tr.inception}).</p>`; return; }
  const bms = Object.keys(rows[rows.length - 1].bench || {});
  const runRate = (book.status.comparables || []).find(c => c.kind === "run_rate");
  const series = [
    { name: "Portfolio", color: "#0B7A5B", w: 2.6, dash: "", vals: rows.map(r => (r.books || {})[id]) },
    ...bms.map((b, i) => ({ name: { SPY: "S&P 500", QQQ: "Nasdaq 100", "^NSEI": "NIFTY 50" }[b] || b, color: i ? "#9AA3AE" : "#2F6DB3", w: 2, dash: i ? "2 4" : "", vals: rows.map(r => r.bench[b]) })),
  ];
  if (runRate) series.push({ name: runRate.name.replace(" (modeled)", "*"), color: "#B9832A", w: 1.8, dash: "6 4", vals: rows.map(r => Math.pow(1 + 0.1072, r.days / 365) - 1) });
  const W = 960, H = 330, M = { t: 18, r: 130, b: 34, l: 50 };
  const all = series.flatMap(s => s.vals).filter(v => v != null);
  const lo = Math.min(0, ...all) - 0.01, hi = Math.max(0, ...all) + 0.01;
  const X = i => M.l + (rows.length === 1 ? 0.5 : i / (rows.length - 1)) * (W - M.l - M.r);
  const Y = v => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative return since inception"><g class="grid">`;
  const step = (hi - lo) / 4;
  for (let k = 0; k <= 4; k++) {
    const v = lo + k * step;
    s += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"></line><text class="ax" x="${M.l - 8}" y="${Y(v) + 3.5}" text-anchor="end">${fmtPct(v, 1)}</text>`;
  }
  s += `</g><line class="zero" x1="${M.l}" x2="${W - M.r}" y1="${Y(0)}" y2="${Y(0)}"></line>`;
  const tickEvery = Math.max(1, Math.floor(rows.length / 6));
  rows.forEach((r, i) => { if (i % tickEvery === 0 || i === rows.length - 1) s += `<text class="ax" x="${X(i)}" y="${H - 10}" text-anchor="middle">${r.date.slice(5)}</text>`; });
  const usedY = [];
  for (const sr of series) {
    const pts = sr.vals.map((v, i) => (v == null ? null : [X(i), Y(v)])).filter(Boolean);
    if (pts.length > 1) s += `<path class="ln" d="${pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ")}" stroke="${sr.color}" stroke-width="${sr.w}" stroke-dasharray="${sr.dash}"></path>`;
    const last = pts[pts.length - 1];
    if (last) {
      let ly = last[1];                              // nudge colliding end labels apart
      while (usedY.some(u => Math.abs(u - ly) < 13)) ly += 13;
      usedY.push(ly);
      s += `<circle cx="${last[0]}" cy="${last[1]}" r="3.8" fill="${sr.color}" stroke="#fff" stroke-width="1.6"></circle><text class="endlab" x="${last[0] + 9}" y="${ly + 4}" fill="${sr.color}">${sr.name} ${fmtPct(sr.vals[sr.vals.length - 1], 1)}</text>`;
    }
  }
  mount.innerHTML = s + `</svg>`;
}

/* ---------- news wire ---------- */
function newsWhen(v) {
  if (typeof v === "number") { const d = new Date(v * 1000); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  if (typeof v === "string" && v.length >= 10) return v.slice(5, 10).replace("-", "/");
  return "";
}
function newsHTML(items, limit, logos, AP) {
  if (!items.length) return `<p class="lede">No headlines fetched yet.</p>`;
  logos = logos || {}; AP = AP ?? ((window.SITE_DATA?.config?.asset_prefix) || "assets/");
  const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return items.slice(0, limit).map(n => {
    const sym = (n.symbol || "").replace(".NS", "");
    const chip = logos[sym] ? `<img class="nlogo" src="${esc(AP + logos[sym])}" alt="" onerror="this.remove()">` : "";
    return `<a class="item" href="${esc(n.link || "#")}" target="_blank" rel="noopener">` +
      `<span class="sym">${chip}${esc(sym)}</span>` +
      `<span class="ttl">${esc(n.title)}</span>` +
      `<span class="src">${esc(n.publisher || "")} ${newsWhen(n.published)}</span></a>`;
  }).join("");
}

/* Live wire: per-holding company news via the feed key (real outlets: Reuters, MarketWatch,
   CNBC, Barron's ... as attributed per item). Falls back to the embedded EOD digest. */
async function liveNews() {
  const D = window.SITE_DATA, key = D.config.finnhub_key;
  if (!key) return;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  for (const [bkey, bk] of Object.entries(D.books)) {
    const el = $("#news-" + bkey);
    if (!el || bk.status.currency !== "USD") continue;
    const all = [];
    for (const h of bk.status.holdings) {
      const sym = (h.symbol || h.ticker);
      if (sym.includes(".")) continue;
      try {
        const r = await (await fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${from}&to=${to}&token=${key}`)).json();
        for (const n of (Array.isArray(r) ? r.slice(0, 4) : []))
          all.push({ symbol: sym, title: n.headline, publisher: n.source, link: n.url, published: n.datetime });
      } catch (_) { /* keep digest */ }
    }
    if (all.length) {
      const seen = new Set();
      const items = all.filter(n => n.title && !seen.has(n.title) && seen.add(n.title))
                       .sort((a, b) => (b.published || 0) - (a.published || 0));
      el.innerHTML = newsHTML(items, 12, bk.logos);
      const tag = $("#wire-src");
      if (tag) tag.textContent = "live wire";
    }
  }
}

/* ---------- feed pill / stamps ---------- */
function setFeed(live, asof) {
  document.querySelectorAll(".feedpill").forEach(p => {
    p.textContent = live ? "LIVE" : "EOD";
    p.classList.toggle("on", !!live);
  });
  if (asof) document.querySelectorAll(".asof .txt").forEach(e => (e.textContent = asof));
}

function renderBook(key) {
  const b = window.SITE_DATA.books[key];
  if (!b) return;
  renderHeatmap(`hm-${key}`, b);
  renderTrack(`tr-${key}`, b);
  renderCompare(`cmp-${key}`, b);
}
function boot() {
  const D = window.SITE_DATA;
  if (!D) return;
  Object.keys(D.books).forEach(renderBook);
  setFeed(false, "data as of " + D.as_of);
  setInterval(refreshFromHost, (D.config.refresh_seconds || 60) * 1000);
  if (D.config.finnhub_key) {
    setTimeout(liveQuotes, 1500);
    setTimeout(liveNews, 3000);
    setInterval(liveQuotes, (D.config.quote_seconds || 20) * 1000);
    setInterval(liveNews, (D.config.news_seconds || 300) * 1000);
  }
}

/* Hosted auto-refresh between deploys; silently keeps the embedded snapshot on file://. */
async function refreshFromHost() {
  const D = window.SITE_DATA;
  try {
    for (const key of Object.keys(D.books)) {
      const r = await fetch(`${D.config.data_prefix || "data/"}${key}_status.json`, { cache: "no-store" });
      if (!r.ok) return;
      const fresh = await r.json();
      if (fresh.as_of !== D.books[key].status.as_of) {
        D.books[key].status = fresh;
        const t = await (await fetch(`${D.config.data_prefix || "data/"}${key}_track.json`, { cache: "no-store" })).json();
        D.books[key].track = t;
        renderBook(key);
        setFeed(false, "data as of " + fresh.as_of);
      }
    }
  } catch (_) { /* embedded snapshot stands */ }
}

/* Live quotes (feed key): every US ticker is repriced in-browser; weights re-derive from the
   drifted equal-weight growth so bigger winners take a bigger tile, exactly like the book. */
async function liveQuotes() {
  const D = window.SITE_DATA, key = D.config.finnhub_key;
  if (!key) return;
  for (const [bkey, bk] of Object.entries(D.books)) {
    const st = bk.status;
    if (st.currency !== "USD") continue;
    let touched = false;
    for (const h of st.holdings) {
      const sym = h.symbol || h.ticker;
      if (sym.includes(".")) continue;
      try {
        const q = await (await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`)).json();
        if (q && q.c) { h.price = q.c; h.day_change = q.dp != null ? q.dp / 100 : h.day_change; touched = true; }
      } catch (_) { /* keep last */ }
    }
    if (touched) {
      const grow = st.holdings.map(h => (h.entry_price && h.price) ? h.price / h.entry_price : null);
      const tot = grow.filter(g => g != null).reduce((a, b) => a + b, 0);
      st.holdings.forEach((h, i) => { if (grow[i] != null) h.weight = grow[i] / tot; });
      const wsum = st.holdings.reduce((a, h) => a + ((h.weight && h.day_change != null) ? h.weight : 0), 0);
      const day = wsum ? st.holdings.reduce((a, h) => a + ((h.weight && h.day_change != null) ? h.weight * h.day_change : 0), 0) / wsum : null;
      const tile = $("#day-" + bkey);
      if (tile && day != null) {
        tile.textContent = fmtPct(day, 2);
        tile.classList.toggle("pos", day >= 0);
        tile.classList.toggle("neg", day < 0);
      }
      renderHeatmap(`hm-${bkey}`, bk);
      setFeed(true, "live · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }
  }
}
document.addEventListener("DOMContentLoaded", boot);
