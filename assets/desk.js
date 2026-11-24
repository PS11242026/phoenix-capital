/* Phoenix Capital research desk (client side, no dependencies):
   - Analyze: any ticker -> on-demand canonical DCF via the analysis API (job + poll) -> full report
   - Basket: saved names, kept in this browser (localStorage), repriced live
   - My portfolios: paper portfolios built from the basket + platform research, tracked live
   Everything a visitor saves stays in their own browser; export/import moves it between devices. */
"use strict";
(function () {
  const DESK = window.DESK || {};
  const API = (DESK.api_url || "").replace(/\/$/, "");
  const ANALYZER = (DESK.analyzer_url || "").replace(/\/$/, "");   // embedded Streamlit analyzer
  const KEY = DESK.finnhub_key || "";
  const PRE = DESK.prefix || "";
  const UNIVERSE = window.DESK_UNIVERSE || [];
  const STORE = "phx.desk.v1";
  const q = (s, el) => (el || document).querySelector(s);
  const qa = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /* ---------------- storage ---------------- */
  let storageOK = true;
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "{}");
      return { basket: Array.isArray(s.basket) ? s.basket : [], portfolios: Array.isArray(s.portfolios) ? s.portfolios : [] };
    } catch (_) { storageOK = false; return { basket: [], portfolios: [] }; }
  }
  let state = load();
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) { storageOK = false; }
    badge();
  }
  window.addEventListener("storage", e => { if (e.key === STORE) { state = load(); badge(); rerender(); } });
  const inBasket = t => state.basket.some(b => b.ticker === t);
  function addToBasket(item) {
    if (!item || !item.ticker) return;
    const i = state.basket.findIndex(b => b.ticker === item.ticker);
    const rec = Object.assign({}, i >= 0 ? state.basket[i] : {}, item, { saved_at: (i >= 0 && state.basket[i].saved_at) || new Date().toISOString() });
    if (i >= 0) state.basket[i] = rec; else state.basket.unshift(rec);
    save(); toast(`${item.ticker} saved to your basket`);
  }
  function removeFromBasket(t) { state.basket = state.basket.filter(b => b.ticker !== t); save(); }
  function badge() {
    qa(".bcount").forEach(b => { const n = state.basket.length; b.textContent = n; b.hidden = !n; });
  }

  /* ---------------- formatting ---------------- */
  const n2 = (x, dp) => Number(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  function fmt(v, f) {
    if (v == null || v === "") return "–";
    if (typeof v === "string") return esc(v);
    if (typeof v === "boolean") return v ? "yes" : "no";
    const cur = /^inr/.test(f || "") ? "₹" : "$";
    switch (f) {
      case "usd": case "inr": return (v < 0 ? "-" : "") + cur + n2(Math.abs(v), 2);
      case "usd0": case "inr0": return (v < 0 ? "-" : "") + cur + n2(Math.abs(v), 0);
      case "usdM": case "inrM": return (v < 0 ? "-" : "") + cur + n2(Math.abs(v) / 1e6, 0) + "M";
      case "usdB": case "inrB": return (v < 0 ? "-" : "") + cur + n2(Math.abs(v) / 1e9, 1) + "B";
      case "pct": case "pct1": return n2(v * 100, 1) + "%";
      case "pct2": return n2(v * 100, 2) + "%";
      case "num0": return n2(v, 0);
      case "x": return n2(v, 1) + "x";
      case "yrs": return n2(v, 1) + " yrs";
      case "bp": return n2(v * 1e4, 0) + " bp";
      default: return Math.abs(v) >= 1000 ? n2(v, 0) : n2(v, Math.abs(v) < 10 ? 2 : 1);
    }
  }
  const pct = (x, dp = 1) => { if (x == null || !isFinite(x)) return "–"; if (Math.abs(x) < 0.5 * Math.pow(10, -dp - 2)) x = 0; return `${x > 0 ? "+" : ""}${(x * 100).toFixed(dp)}%`; };
  const usd = x => x == null || !isFinite(x) ? "–" : "$" + n2(x, 2);
  const usd0 = x => x == null || !isFinite(x) ? "–" : "$" + n2(x, 0);
  const cls = x => x == null || !isFinite(x) ? "" : x > -5e-5 ? "pos" : "neg";
  const verdictCls = v => /very attractive|^attractive/i.test(v || "") ? "v-pos" : /unattractive/i.test(v || "") ? "v-neg" : "v-mid";
  const dateS = iso => { try { return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); } catch (_) { return iso || ""; } };

  /* ---------------- live quotes (Finnhub, cached ~50 s) ---------------- */
  const qcache = {};
  async function quote(sym) {
    if (!KEY || !sym || sym.includes(".")) return null;
    const c = qcache[sym];
    if (c && Date.now() - c.at < 50000) return c.v;
    try {
      const r = await (await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${KEY}`)).json();
      const v = r && r.c ? { price: r.c, dp: r.dp != null ? r.dp / 100 : null } : null;
      qcache[sym] = { at: Date.now(), v };
      return v;
    } catch (_) { return null; }
  }
  async function quotes(syms) {
    const out = {};
    for (const s of [...new Set(syms)]) out[s] = await quote(s);
    return out;
  }

  /* ---------------- toast ---------------- */
  function toast(msg) {
    let t = q("#desk-toast");
    if (!t) { t = document.createElement("div"); t.id = "desk-toast"; t.className = "desk-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("on");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2400);
  }

  /* ---------------- SVG line chart ---------------- */
  function lineChart(series, labels, opts = {}) {
    const W = 760, H = opts.h || 260, L = 62, R = 16, T = 14, B = 30;
    const ys = series.flatMap(s => s.points.map(p => p[1])).filter(v => v != null && isFinite(v));
    if (!ys.length) return "";
    let lo = Math.min(0, ...ys), hi = Math.max(...ys);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.08; hi += pad; if (lo < 0) lo -= pad;
    const nx = labels.length;
    const X = i => L + (nx <= 1 ? 0 : (i / (nx - 1)) * (W - L - R));
    const Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = 4, f = opts.yfmt || (v => v.toFixed(0));
    let g = "";
    for (let k = 0; k <= ticks; k++) {
      const v = lo + (k / ticks) * (hi - lo), y = Y(v);
      g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text class="ax" x="${L - 8}" y="${y + 3.5}" text-anchor="end">${esc(f(v))}</text>`;
    }
    const step = Math.max(1, Math.ceil(nx / 8));
    let xl = "";
    for (let i = 0; i < nx; i += step) xl += `<text class="ax" x="${X(i)}" y="${H - 9}" text-anchor="middle">${esc(labels[i])}</text>`;
    let zero = lo < 0 ? `<line class="zero" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>` : "";
    let split = opts.split != null ? `<line x1="${X(opts.split)}" x2="${X(opts.split)}" y1="${T}" y2="${H - B}" stroke="#C4CBD4" stroke-dasharray="3 4"/><text class="ax" x="${X(opts.split) + 6}" y="${T + 10}">forecast →</text>` : "";
    let lines = "";
    for (const s of series) {
      let d = "", pen = false;
      s.points.forEach(([i, v]) => {
        if (v == null || !isFinite(v)) { pen = false; return; }
        d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
      });
      if (d) lines += `<path class="ln" d="${d}" stroke="${s.color}" stroke-width="${s.w || 2.2}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
    }
    const legend = `<div class="legend">${series.filter(s => !s.nolegend).map(s => `<span class="it"><span class="sw" style="border-color:${s.color}${s.dash ? ";border-top-style:dashed" : ""}"></span>${esc(s.name)}</span>`).join("")}</div>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "chart")}"><g class="grid">${g}</g>${zero}${split}${lines}${xl}</svg>${legend}`;
  }
  const mfmt = v => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${v.toFixed(0)}M`);

  /* ======================= ANALYZE ======================= */
  let runToken = 0;
  function analyzePage() {
    const form = q("#az-form"); if (!form) return;
    const input = q("#az-input");
    form.addEventListener("submit", e => { e.preventDefault(); const t = input.value.trim().toUpperCase(); if (t) start(t, false); });
    qa(".qpick").forEach(b => b.addEventListener("click", () => { input.value = b.dataset.tk; start(b.dataset.tk, false); }));
    const t0 = new URLSearchParams(location.search).get("t");
    if (t0) { input.value = t0.toUpperCase(); start(t0.toUpperCase(), false, true); }
  }
  const STEPS = ["Fetching SEC filings and market data", "Fitting the Kalman state-space FCF model",
    "Discounting cash flows and terminal value", "Running sensitivity and building the report"];
  function progress(t, msg, elapsed, waking) {
    const est = 35, frac = Math.min(0.95, (elapsed || 0) / est), si = Math.min(STEPS.length - 1, Math.floor(frac * STEPS.length));
    q("#az-status").innerHTML = `<div class="card az-prog">
      <div class="az-prog-top"><b>${esc(t)}</b><span class="tab">${elapsed ? elapsed.toFixed(0) + "s" : ""}</span></div>
      <div class="az-bar"><span style="width:${(waking ? 6 : frac * 100).toFixed(1)}%"></span></div>
      <ol class="az-steps">${STEPS.map((s, i) => `<li class="${waking ? "" : i < si ? "done" : i === si ? "on" : ""}">${s}</li>`).join("")}</ol>
      <p class="az-msg">${esc(msg)}</p></div>`;
  }
  function embedAnalyzer(t, scroll) {
    history.replaceState(null, "", `?t=${encodeURIComponent(t)}`);
    const src = `${ANALYZER}/?embed=true&embed_options=light_theme&from=site&t=${encodeURIComponent(t)}`;
    q("#az-status").innerHTML = `<p class="fine az-note">Running live on the analysis server. A full report takes about 20–60 seconds.
      If it shows a sleep screen, press its wake-up button and give it a minute (free hosting sleeps when idle).
      <a href="${esc(src.replace("embed=true&embed_options=light_theme&from=site&", ""))}" target="_blank" rel="noopener">Open full screen ↗</a></p>`;
    q("#az-report").innerHTML = `<div class="az-frame"><iframe src="${esc(src)}" title="DCF report for ${esc(t)}" loading="eager"></iframe></div>`;
    if (scroll) q("#az-report").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function start(t, refresh, fromUrl) {
    if (ANALYZER) return embedAnalyzer(t, !fromUrl);
    const tok = ++runToken;
    history.replaceState(null, "", `?t=${encodeURIComponent(t)}`);
    q("#az-report").innerHTML = "";
    if (!API) { q("#az-status").innerHTML = `<div class="callout">The analysis server isn't configured for this site yet.</div>`; return; }
    const t0 = Date.now(); let first = true, fails = 0;
    progress(t, "Contacting the analysis server…", 0, true);
    while (tok === runToken) {
      let r, body;
      try {
        r = await fetch(`${API}/api/analyze/${encodeURIComponent(t)}${first && refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
        body = await r.json(); fails = 0;
      } catch (_) {
        fails++;
        const el = (Date.now() - t0) / 1000;
        if (el > 240) { q("#az-status").innerHTML = `<div class="callout">The analysis server didn't respond. It may be restarting; please try again in a minute.</div>`; return; }
        progress(t, "Waking the analysis server (free tier; the first request after a quiet spell can take a minute)…", el, true);
        await sleep(5000); continue;
      }
      first = false;
      if (tok !== runToken) return;
      if (r.status === 400) { q("#az-status").innerHTML = `<div class="callout">${esc(body.detail || "Invalid ticker.")}</div>`; return; }
      if (body.status === "done") { q("#az-status").innerHTML = ""; renderReport(body.report); return; }
      if (body.status === "error") { q("#az-status").innerHTML = `<div class="callout"><b>${esc(t)}:</b> ${esc(body.error)}</div>`; return; }
      const el = (Date.now() - t0) / 1000;
      progress(t, body.status === "queued" && body.position > 1 ? `Queued: ${body.position - 1} analysis ahead of yours.` : "Running the canonical DCF engine live. A full report usually takes 20–60 seconds.", el, false);
      await sleep(2500);
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function rangeBar(p10, p90, iv, px) {
    if (p10 == null || p90 == null) return "";
    const lo = Math.min(p10, px || p10, iv) * 0.9, hi = Math.max(p90, px || p90, iv) * 1.05;
    const P = v => ((v - lo) / (hi - lo) * 100).toFixed(2);
    return `<div class="card rb"><h3>Where the price sits in the model's value range <span class="sub">P10 – P90 intrinsic value</span></h3>
      <div class="rb-track"><span class="rb-band" style="left:${P(p10)}%;width:${P(p90) - P(p10)}%"></span>
      <span class="rb-iv" style="left:${P(iv)}%" title="Intrinsic value"></span>
      ${px ? `<span class="rb-px" id="rb-px" style="left:${P(px)}%"><i>price</i></span>` : ""}</div>
      <div class="rb-lab"><span style="left:${P(p10)}%">P10 ${usd(p10)}</span><span style="left:${P(iv)}%"><b>DCF ${usd(iv)}</b></span><span style="left:${P(p90)}%">P90 ${usd(p90)}</span></div></div>`;
  }

  function sectionHTML(s, i) {
    let h = `<section class="card rp-sec" id="sec-${i}"><h2 class="sec">${esc(s.title)}</h2>`;
    if (s.metrics.length) h += `<div class="kpis rp-kpis">${s.metrics.map(m => `<div class="tile"><div class="lab">${esc(m.label)}</div><div class="val ${typeof m.value === "number" && m.good != null ? (m.good ? "pos" : "neg") : ""}">${fmt(m.value, m.fmt)}</div>${m.note ? `<div class="sub">${esc(m.note)}</div>` : ""}</div>`).join("")}</div>`;
    for (const c of s.charts) {
      const xs = c.rows.map(r => String(r[c.x_col]));
      const pal = ["#0B7A5B", "#2F6DB3", "#B9832A"];
      h += `<div class="chart">${lineChart(c.y_cols.map((col, k) => ({ name: c.columns[col], color: pal[k % 3], points: c.rows.map((r, j) => [j, typeof r[col] === "number" ? r[col] / 1e6 : null]) })), xs, { yfmt: mfmt, label: c.title })}</div>`;
    }
    for (const t of s.tables) {
      const nums = new Set(t.heatmap_cols || []);
      let lo = Infinity, hi = -Infinity;
      t.rows.forEach(r => nums.forEach(c => { if (typeof r[c] === "number") { lo = Math.min(lo, r[c]); hi = Math.max(hi, r[c]); } }));
      const heat = v => { if (typeof v !== "number" || !(hi > lo)) return ""; const a = (v - lo) / (hi - lo); return ` style="background:rgba(${a >= .5 ? "11,122,91" : "192,69,59"},${(Math.abs(a - .5) * 0.5).toFixed(2)})"`; };
      h += `${t.title ? `<h3 class="rp-tt">${esc(t.title)}</h3>` : ""}<div class="tbl"><table><thead><tr>${t.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r, ri) => `<tr class="${t.total_row && ri === t.rows.length - 1 ? "total" : ""}">${r.map((v, ci) => `<td${nums.has(ci) ? heat(v) : ""}>${fmt(v, (t.formats || [])[ci])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    for (const im of s.images) if (im.src) h += `<figure class="rp-fig"><img src="${im.src}" alt="${esc(im.title)}" loading="lazy"><figcaption>${esc(im.title)}</figcaption></figure>`;
    const nar = s.narrative.filter(x => x && x.trim());
    if (nar.length) h += `<ul class="rp-nar">${nar.map(x => /:$/.test(x) ? `</ul><h3 class="rp-tt">${esc(x)}</h3><ul class="rp-nar">` : `<li>${esc(x)}</li>`).join("")}</ul>`;
    return h + `</section>`;
  }

  function renderReport(r) {
    const mount = q("#az-report");
    const iv = r.intrinsic_value, px = r.price, d = r.discount;
    const fx = r.files || {};
    const file = n => `${API}/api/files/${encodeURIComponent(r.ticker)}/${encodeURIComponent(n)}`;
    const item = { ticker: r.ticker, company: r.company, intrinsic: iv, price: px, discount: d, verdict: r.verdict,
      p10: (r.range_p10_p90 || [])[0], p90: (r.range_p10_p90 || [])[1], analyzed_at: r.as_of, source: "analysis" };
    // history + forecast chart ($M, quarterly)
    const hp = (r.history && r.history.period) || [], fp = (r.forecast && r.forecast.revenue) || [];
    const labels = hp.map(p => String(p).slice(0, 7)).concat(fp.map((_, i) => `F${i + 1}`));
    const M = v => typeof v === "number" ? v / 1e6 : null;
    const nH = hp.length;
    const chart = labels.length ? lineChart([
      { name: "Revenue (reported)", color: "#0F141B", points: (r.history.revenue || []).map((v, i) => [i, M(v)]) },
      { name: "Revenue (forecast)", color: "#0B7A5B", dash: "6 5", points: (nH ? [[nH - 1, M(r.history.revenue[nH - 1])]] : []).concat(fp.map((v, i) => [nH + i, M(v)])) },
      { name: "FCF (reported)", color: "#8A94A2", points: (r.history.fcf || []).map((v, i) => [i, M(v)]) },
      { name: "FCF (forecast)", color: "#2F6DB3", dash: "6 5", points: (nH ? [[nH - 1, M(r.history.fcf[nH - 1])]] : []).concat((r.forecast.fcf || []).map((v, i) => [nH + i, M(v)])) },
    ], labels, { yfmt: mfmt, split: nH ? nH - 1 : null, label: "Revenue and free cash flow, reported and forecast", h: 280 }) : "";
    const secs = (r.model && r.model.sections) || [];
    mount.innerHTML = `
      <section class="rp-head">
        <div class="rp-id"><span class="rp-tk">${esc(r.ticker)}</span>
          <h2>${esc(r.company || r.ticker)}</h2>
          <div class="rp-sub">${esc((r.sector || "").replace(/_/g, " "))} · ${esc((r.regime || "").replace(/_/g, " "))} · analyzed ${esc(r.as_of)}</div></div>
        <div class="rp-actions">
          <button class="cta" id="rp-save" type="button">${inBasket(r.ticker) ? "★ In your basket" : "☆ Save to basket"}</button>
          ${fx.xlsx ? `<a class="cta ghost" href="${file(fx.xlsx)}">Excel workbook</a>` : ""}
          ${fx.pdf ? `<a class="cta ghost" href="${file(fx.pdf)}">PDF report</a>` : ""}
          <button class="cta ghost" id="rp-rerun" type="button" title="Re-run with fresh data">Re-run</button></div>
      </section>
      <div class="kpis">
        <div class="tile"><div class="lab">DCF intrinsic / share</div><div class="val">${usd(iv)}</div><div class="sub">engine ${esc(r.engine)} · P50 ${usd(r.p50)}</div></div>
        <div class="tile"><div class="lab">Price <span class="feedpill pill" id="rp-feed">CLOSE</span></div><div class="val" id="rp-px">${usd(px)}</div><div class="sub" id="rp-dp">at analysis</div></div>
        <div class="tile"><div class="lab">Upside to intrinsic</div><div class="val ${cls(d)}" id="rp-up">${pct(d)}</div><div class="sub">intrinsic ÷ price − 1</div></div>
        <div class="tile"><div class="lab">Verdict</div><div class="val"><span class="verdict ${verdictCls(r.verdict)}">${esc(r.verdict)}</span></div><div class="sub">${esc(r.confidence || "")}</div></div>
      </div>
      ${rangeBar(item.p10, item.p90, iv, px)}
      ${chart ? `<section class="card chart rp-chart"><h3>Revenue &amp; free cash flow <span class="sub">quarterly, $ · reported history then Kalman-filtered forecast</span></h3>${chart}</section>` : ""}
      <nav class="rp-toc">${secs.map((s, i) => `<a href="#sec-${i}">${esc(s.title)}</a>`).join("")}</nav>
      ${secs.map(sectionHTML).join("")}
      <p class="rp-foot">Generated live by the open-source canonical engine (${esc(r.engine)}) from SEC EDGAR filings and market data. Research and education only; not investment advice.</p>`;
    q("#rp-save").addEventListener("click", e => { addToBasket(item); e.currentTarget.textContent = "★ In your basket"; });
    q("#rp-rerun").addEventListener("click", () => start(r.ticker, true));
    livePrice(r.ticker, iv);
  }
  async function livePrice(t, iv) {
    const v = await quote(t);
    if (!v || !q("#rp-px")) return;
    q("#rp-px").textContent = usd(v.price);
    q("#rp-dp").innerHTML = `<span class="${cls(v.dp)}">${pct(v.dp, 2)}</span> today`;
    const up = iv / v.price - 1, u = q("#rp-up");
    u.textContent = pct(up); u.className = "val " + cls(up);
    const f = q("#rp-feed"); f.textContent = "LIVE"; f.classList.add("on");
  }

  /* ======================= BASKET ======================= */
  async function basketPage() {
    const root = q("#bk-root"); if (!root) return;
    const B = state.basket;
    const extra = UNIVERSE.filter(u => !inBasket(u.ticker));
    const adder = extra.length ? `<div class="card bk-add"><h3>Add from the platform's research <span class="sub">model portfolio names, DCF from the scheduled pipeline</span></h3>
      <div class="chips-row">${extra.map(u => `<button type="button" class="qpick add" data-tk="${esc(u.ticker)}">+ ${esc(u.ticker)} <small>${pct(u.discount, 0)}</small></button>`).join("")}</div></div>` : "";
    if (!B.length) {
      root.innerHTML = `<div class="card empty"><h3>Your basket is empty</h3><p>Run an analysis on any ticker and press <b>Save to basket</b>, or add names from the model portfolio below.</p>
        <a class="cta" href="${PRE}analyze.html">Analyze a company</a></div>${adder}${storageNote()}`;
      wireAdd(root); return;
    }
    root.innerHTML = `<div class="card"><div class="bk-bar"><span id="bk-sel">0 selected</span>
        <button class="cta" id="bk-build" type="button" disabled>Build a portfolio from selected</button></div>
      <div class="tbl"><table class="bk-tbl"><thead><tr><th><input type="checkbox" id="bk-all" aria-label="Select all"></th><th>Name</th><th>Saved</th><th>Price</th><th>1-day</th><th>DCF intrinsic</th><th>Upside now</th><th>Verdict</th><th></th></tr></thead>
      <tbody>${B.map(b => `<tr data-tk="${esc(b.ticker)}">
        <td><input type="checkbox" class="bk-cb" value="${esc(b.ticker)}" aria-label="Select ${esc(b.ticker)}"></td>
        <td><div class="tk-cell"><div><b>${esc(b.ticker)}</b><span class="co">${esc(b.company || "")}</span></div></div></td>
        <td>${esc(dateS(b.saved_at))}<span class="co2">${esc(b.source || "")}</span></td>
        <td class="px">${usd(b.price)}</td><td class="dp">–</td><td>${usd(b.intrinsic)}</td>
        <td class="up ${cls(b.discount)}">${pct(b.discount)}</td>
        <td>${b.verdict ? `<span class="verdict ${verdictCls(b.verdict)}">${esc(b.verdict)}</span>` : "–"}</td>
        <td><div class="acts"><a href="${PRE}analyze.html?t=${encodeURIComponent(b.ticker)}">Full report</a><button type="button" class="lnk rm" data-tk="${esc(b.ticker)}">Remove</button></div></td></tr>`).join("")}</tbody></table></div>
      <p class="fine">${KEY ? "Prices update live during market hours." : "Prices shown as saved."} Upside now = DCF intrinsic ÷ current price − 1.</p></div>${adder}${storageNote()}`;
    const sel = () => qa(".bk-cb:checked").map(c => c.value);
    const upd = () => { const s = sel(); q("#bk-sel").textContent = `${s.length} selected`; q("#bk-build").disabled = !s.length; };
    qa(".bk-cb").forEach(c => c.addEventListener("change", upd));
    q("#bk-all").addEventListener("change", e => { qa(".bk-cb").forEach(c => (c.checked = e.target.checked)); upd(); });
    q("#bk-build").addEventListener("click", () => { location.href = `${PRE}portfolios.html?sel=${encodeURIComponent(sel().join(","))}`; });
    qa(".rm").forEach(b => b.addEventListener("click", () => { removeFromBasket(b.dataset.tk); basketPage(); }));
    wireAdd(root);
    basketPrices();
  }
  async function basketPrices() {
    const root = q("#bk-root"); if (!root || !state.basket.length) return;
    const B = state.basket;
    const qs = await quotes(B.map(b => b.ticker));
    for (const b of B) {
      const v = qs[b.ticker], row = q(`tr[data-tk="${CSS.escape(b.ticker)}"]`, root);
      if (!v || !row) continue;
      q(".px", row).textContent = usd(v.price);
      q(".dp", row).innerHTML = `<span class="${cls(v.dp)}">${pct(v.dp, 2)}</span>`;
      const up = b.intrinsic ? b.intrinsic / v.price - 1 : null, c = q(".up", row);
      c.textContent = pct(up); c.className = "up " + cls(up);
    }
  }
  function wireAdd(root) {
    qa(".qpick.add", root).forEach(b => b.addEventListener("click", () => {
      const u = UNIVERSE.find(x => x.ticker === b.dataset.tk);
      if (u) { addToBasket(Object.assign({}, u, { source: "model portfolio" })); basketPage(); }
    }));
  }
  const storageNote = () => storageOK ? "" : `<div class="callout" style="margin-top:14px">This browser is blocking site storage (private mode?), so saved items won't persist after you leave.</div>`;

  /* ======================= PORTFOLIOS ======================= */
  function candidates() {
    const m = new Map();
    state.basket.forEach(b => m.set(b.ticker, Object.assign({ group: "Your basket" }, b)));
    UNIVERSE.forEach(u => { if (!m.has(u.ticker)) m.set(u.ticker, Object.assign({ group: "Platform research" }, u)); });
    return [...m.values()];
  }
  async function portfoliosPage() {
    const root = q("#pf-root"); if (!root) return;
    const pre = (new URLSearchParams(location.search).get("sel") || "").split(",").filter(Boolean);
    const C = candidates();
    const preset = pre.length ? new Set(pre) : new Set(state.portfolios.length ? [] : state.basket.map(b => b.ticker));
    const groups = ["Your basket", "Platform research"].map(g => [g, C.filter(c => c.group === g)]).filter(([, l]) => l.length);
    root.innerHTML = `
      <details class="card pf-new" ${pre.length || !state.portfolios.length ? "open" : ""}><summary><h3>Build a new portfolio</h3></summary>
        <div class="pf-form">
          <label>Name<input id="pf-name" value="My portfolio ${state.portfolios.length + 1}" maxlength="40"></label>
          <label>Capital ($)<input id="pf-cap" type="number" min="100" step="100" value="100000"></label>
          <fieldset class="pf-w"><legend>Weighting</legend>
            <label><input type="radio" name="pfw" value="equal" checked> Equal</label>
            <label><input type="radio" name="pfw" value="upside"> By DCF upside</label>
            <label><input type="radio" name="pfw" value="custom"> Custom</label></fieldset>
        </div>
        ${groups.map(([g, l]) => `<div class="pf-group"><div class="pf-gl">${esc(g)}</div><div class="pf-picks">${l.map(c => `
          <label class="pf-pick"><input type="checkbox" value="${esc(c.ticker)}" ${preset.has(c.ticker) ? "checked" : ""}>
            <span class="pk-tk">${esc(c.ticker)}</span><span class="pk-co">${esc(c.company || "")}</span>
            <span class="pk-up ${cls(c.discount)}">${pct(c.discount, 0)}</span></label>`).join("")}</div></div>`).join("") || `<p class="fine">Nothing to pick yet. <a href="${PRE}analyze.html">Analyze a company</a> first.</p>`}
        <div id="pf-preview"></div>
        <div class="pf-go"><button class="cta" id="pf-create" type="button">Create portfolio</button><span class="fine" id="pf-msg"></span></div>
      </details>
      <div id="pf-list"></div>
      <div class="card pf-data"><h3>Your data</h3><p class="fine">Basket and portfolios live only in this browser. Export them to keep a copy or move to another device.</p>
        <button class="cta ghost" id="pf-export" type="button">Export file</button>
        <label class="cta ghost pf-imp">Import file<input type="file" id="pf-import" accept="application/json" hidden></label></div>${storageNote()}`;
    const custom = {};
    const picked = () => qa(".pf-pick input:checked", root).map(i => C.find(c => c.ticker === i.value)).filter(Boolean);
    const mode = () => (q('input[name="pfw"]:checked', root) || {}).value;
    function weights(list) {
      if (!list.length) return [];
      if (mode() === "upside") {
        const s = list.map(c => Math.max(0.02, c.discount || 0)), t = s.reduce((a, b) => a + b, 0);
        return s.map(x => x / t);
      }
      if (mode() === "custom") {
        const s = list.map(c => Math.max(0, +(custom[c.ticker] ?? (100 / list.length)))), t = s.reduce((a, b) => a + b, 0) || 1;
        return s.map(x => x / t);
      }
      return list.map(() => 1 / list.length);
    }
    function preview() {
      const list = picked(), w = weights(list), cap = +q("#pf-cap").value || 0;
      const wUp = list.reduce((a, c, i) => a + (c.discount != null ? w[i] * c.discount : 0), 0);
      q("#pf-preview").innerHTML = list.length ? `<div class="tbl"><table><thead><tr><th>Name</th><th>Weight</th><th>Allocation</th><th>DCF upside</th></tr></thead><tbody>
        ${list.map((c, i) => `<tr><td><b>${esc(c.ticker)}</b> <span class="co2">${esc(c.company || "")}</span></td>
          <td>${mode() === "custom" ? `<input class="pf-cw" data-tk="${esc(c.ticker)}" type="number" min="0" step="1" value="${(+(custom[c.ticker] ?? (100 / list.length))).toFixed(0)}" aria-label="Weight for ${esc(c.ticker)}">` : (w[i] * 100).toFixed(1) + "%"}</td>
          <td>${usd0(w[i] * cap)}</td><td class="${cls(c.discount)}">${pct(c.discount)}</td></tr>`).join("")}
        <tr class="total"><td>Portfolio</td><td>100%</td><td>${usd0(cap)}</td><td class="${cls(wUp)}">${pct(wUp)}</td></tr></tbody></table></div>
        <p class="fine">Weighted DCF upside is the portfolio's average gap between intrinsic value and price; it is a model output, not a forecast of returns.</p>` : "";
      qa(".pf-cw", root).forEach(inp => inp.addEventListener("change", () => { custom[inp.dataset.tk] = +inp.value; preview(); }));
    }
    qa(".pf-pick input, input[name=pfw]", root).forEach(i => i.addEventListener("change", preview));
    q("#pf-cap").addEventListener("input", preview);
    preview();
    q("#pf-create").addEventListener("click", async () => {
      const list = picked(), msg = q("#pf-msg");
      if (!list.length) { msg.textContent = "Pick at least one company."; return; }
      const cap = +q("#pf-cap").value; if (!(cap > 0)) { msg.textContent = "Enter the capital to invest."; return; }
      msg.textContent = "Recording entry prices…";
      const w = weights(list), qs = await quotes(list.map(c => c.ticker).concat("SPY"));
      const holdings = [], skipped = [];
      list.forEach((c, i) => {
        const entry = (qs[c.ticker] && qs[c.ticker].price) || c.price;
        if (!entry) { skipped.push(c.ticker); return; }
        holdings.push({ ticker: c.ticker, company: c.company || "", weight: w[i], entry, shares: (w[i] * cap) / entry, intrinsic: c.intrinsic ?? null });
      });
      if (!holdings.length) { msg.textContent = "No prices available for those names."; return; }
      const invested = holdings.reduce((a, h) => a + h.shares * h.entry, 0);
      state.portfolios.unshift({ id: Date.now().toString(36), name: (q("#pf-name").value || "My portfolio").slice(0, 40), created: new Date().toISOString(),
        capital: cap, cash: cap - invested, holdings, bench: qs.SPY ? { sym: "SPY", entry: qs.SPY.price } : null });
      save(); history.replaceState(null, "", location.pathname);
      toast("Portfolio created" + (skipped.length ? ` (skipped ${skipped.join(", ")}: no price)` : ""));
      portfoliosPage();
    });
    q("#pf-export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ app: "phoenix-desk", version: 1, exported: new Date().toISOString(), ...state }, null, 2)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "phoenix-desk.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    q("#pf-import").addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (!d || (!Array.isArray(d.basket) && !Array.isArray(d.portfolios))) throw 0;
        const bt = new Set(state.basket.map(b => b.ticker)), pid = new Set(state.portfolios.map(p => p.id));
        (d.basket || []).filter(b => b && b.ticker && !bt.has(b.ticker)).forEach(b => state.basket.push(b));
        (d.portfolios || []).filter(p => p && p.id && Array.isArray(p.holdings) && !pid.has(p.id)).forEach(p => state.portfolios.push(p));
        save(); toast("Imported"); portfoliosPage();
      } catch (_) { toast("That file isn't a Phoenix desk export"); }
    });
    renderPortfolios();
  }
  async function renderPortfolios() {
    const list = q("#pf-list"); if (!list) return;
    if (!state.portfolios.length) { list.innerHTML = ""; return; }
    const syms = state.portfolios.flatMap(p => p.holdings.map(h => h.ticker).concat(p.bench ? [p.bench.sym] : []));
    const draw = qs => {
      list.innerHTML = state.portfolios.map(p => {
        let val = p.cash || 0, day = 0, dayW = 0;
        const rows = p.holdings.map(h => {
          const v = qs && qs[h.ticker], px = (v && v.price) || h.entry, mv = h.shares * px;
          val += mv; if (v && v.dp != null) { day += mv * v.dp / (1 + v.dp); dayW += mv; }
          return { h, px, mv, ret: px / h.entry - 1, up: h.intrinsic ? h.intrinsic / px - 1 : null, live: !!v };
        });
        const ret = val / p.capital - 1;
        const b = p.bench, bq = b && qs && qs[b.sym], bret = b && bq ? bq.price / b.entry - 1 : null;
        return `<section class="card pf-card"><div class="pf-head"><div><h3>${esc(p.name)}</h3><span class="fine">created ${esc(dateS(p.created))} · ${p.holdings.length} names · ${usd0(p.capital)} start</span></div>
          <div class="pf-kpis"><div><span class="lab">Value</span><b class="tab">${usd0(val)}</b></div>
            <div><span class="lab">Return</span><b class="tab ${cls(ret)}">${pct(ret, 2)}</b></div>
            <div><span class="lab">Today</span><b class="tab ${cls(dayW ? day / val : null)}">${dayW ? pct(day / (val - day), 2) : "–"}</b></div>
            <div><span class="lab">S&amp;P 500 (SPY)</span><b class="tab ${cls(bret)}">${pct(bret, 2)}</b></div></div></div>
          <div class="tbl"><table><thead><tr><th>Name</th><th>Weight @ entry</th><th>Entry</th><th>Price</th><th>Return</th><th>Value</th><th>DCF upside now</th></tr></thead><tbody>
          ${rows.map(r => `<tr><td><b>${esc(r.h.ticker)}</b> <span class="co2">${esc(r.h.company)}</span></td><td>${(r.h.weight * 100).toFixed(1)}%</td><td>${usd(r.h.entry)}</td>
            <td>${usd(r.px)}${r.live ? "" : ' <span class="co2">entry</span>'}</td><td class="${cls(r.ret)}">${pct(r.ret)}</td><td>${usd0(r.mv)}</td><td class="${cls(r.up)}">${pct(r.up)}</td></tr>`).join("")}
          ${p.cash > 0.5 ? `<tr><td>Cash</td><td></td><td></td><td></td><td></td><td>${usd0(p.cash)}</td><td></td></tr>` : ""}</tbody></table></div>
          <div class="pf-acts"><a href="${PRE}analyze.html?t=${encodeURIComponent(p.holdings[0].ticker)}">Research a holding</a>
            <button type="button" class="lnk pf-del" data-id="${esc(p.id)}">Delete portfolio</button></div></section>`;
      }).join("");
      qa(".pf-del", list).forEach(btn => btn.addEventListener("click", () => {
        if (btn.dataset.armed) { state.portfolios = state.portfolios.filter(p => p.id !== btn.dataset.id); save(); renderPortfolios(); return; }
        btn.dataset.armed = "1"; btn.textContent = "Click again to delete"; btn.classList.add("arm");
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "Delete portfolio"; btn.classList.remove("arm"); } }, 4000);
      }));
    };
    draw(null);
    draw(await quotes(syms));
  }

  /* ======================= model-book save buttons ======================= */
  function holdingsButtons() {
    qa("tr[data-save]").forEach(tr => {
      let item; try { item = JSON.parse(tr.dataset.save); } catch (_) { return; }
      const cell = q(".tk-cell", tr) || tr.cells[0]; if (!cell || q(".save-btn", cell)) return;
      const b = document.createElement("button");
      b.type = "button"; b.className = "save-btn";
      const sync = () => { const on = inBasket(item.ticker); b.textContent = on ? "★" : "☆"; b.title = on ? "In your basket" : "Save to basket"; b.setAttribute("aria-pressed", on); };
      b.addEventListener("click", () => { if (inBasket(item.ticker)) { removeFromBasket(item.ticker); toast(`${item.ticker} removed`); } else addToBasket(item); sync(); });
      sync(); cell.appendChild(b);
    });
  }

  function rerender() { basketPage(); renderPortfolios(); }

  /* ======================= hand-off from the analyzer ======================= */
  // The embedded analyzer posts {type:"phx-save", item}; opened standalone it links to
  // basket.html?add=<base64url JSON>. Either way only whitelisted, typed fields are kept.
  function cleanItem(x) {
    if (!x || typeof x !== "object") return null;
    const t = String(x.ticker || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,9}([.\-][A-Z0-9]{1,3})?$/.test(t)) return null;
    const num = v => (typeof v === "number" && isFinite(v) ? v : null);
    const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    return { ticker: t, company: str(x.company, 80), intrinsic: num(x.intrinsic), price: num(x.price),
      discount: num(x.discount), verdict: str(x.verdict, 30), p10: num(x.p10), p90: num(x.p90),
      analyzed_at: str(x.analyzed_at, 40), source: "analysis" };
  }
  window.addEventListener("message", e => {
    let host = ""; try { host = new URL(e.origin).hostname; } catch (_) { return; }
    const ok = /\.streamlit\.app$/.test(host) || host === "localhost" || host === "127.0.0.1";
    if (!ok || !e.data || e.data.type !== "phx-save") return;
    const it = cleanItem(e.data.item);
    if (it) addToBasket(it);
  });
  function addFromLink() {
    const p = new URLSearchParams(location.search), raw = p.get("add");
    if (!raw) return;
    try {
      const it = cleanItem(JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))));
      if (it) addToBasket(it);
    } catch (_) { /* ignore a malformed link */ }
    p.delete("add");
    history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p : ""));
  }

  document.addEventListener("DOMContentLoaded", () => {
    addFromLink();
    badge(); holdingsButtons(); analyzePage(); basketPage(); portfoliosPage();
    if (KEY) setInterval(() => { basketPrices(); if (q("#pf-list")) renderPortfolios(); }, 60000);
  });
})();
